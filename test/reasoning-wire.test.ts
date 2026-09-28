/**
 * Real SDKs over the wire, for the two reasoning protocols:
 *   OpenAI Responses (encrypted reasoning items) -> quota -> Anthropic (signed thinking blocks)
 * Checks that each model gets its own reasoning back unchanged within a tool
 * loop, and never sees the other vendor's.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/loop.js';
import { Session } from '../src/ir/session.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import { OpenAIResponsesAdapter } from '../src/providers/openai-responses.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { Router } from '../src/router/router.js';
import { ToolEngine } from '../src/tools/registry.js';
import { FakeProviders, aText, aThinking, aToolUse, anthropicStream, json, rCall, rMessage, rReasoning, responsesStream } from './fake-providers.js';

const fake = new FakeProviders();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

type Item = Record<string, unknown>;
type Block = Record<string, unknown>;

describe('reasoning round-trip across a provider switch', () => {
  it('replays each vendor its own reasoning and drops the other vendor’s', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'baton-reason-'));
    writeFileSync(join(cwd, 'app.ts'), 'export const port = 3000;\n');
    execFileSync('git', ['init', '-q'], { cwd });

    fake.on(
      '/v1/responses',
      (_b, res) => responsesStream(res, [rReasoning('rs_1', 'ENC_OPENAI_1'), rMessage('Checking.'), rCall('call_1', 'read_file', { path: 'app.ts' })], { text: 'Checking.' }),
      (_b, res) => responsesStream(res, [rReasoning('rs_2', 'ENC_OPENAI_2'), rCall('call_2', 'edit_file', { path: 'app.ts', old_string: '3000', new_string: '8080' })]),
      (_b, res) => json(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }),
    );
    fake.on(
      '/v1/messages',
      (_b, res) => anthropicStream(res, [aThinking('SIG_CLAUDE_1'), aToolUse('toolu_1', 'bash', { command: 'cat app.ts' })], 'tool_use'),
      (_b, res) => anthropicStream(res, [aThinking('SIG_CLAUDE_2'), aText('Port is now 8080.')], 'end_turn'),
    );

    const adapters = new Map<string, ProviderAdapter>([
      ['openai', new OpenAIResponsesAdapter({ name: 'openai', apiKey: 'sk-test', baseURL: `${fake.base}/v1` })],
      ['anthropic', new AnthropicAdapter({ name: 'anthropic', apiKey: 'sk-ant-test', baseURL: fake.base })],
    ]);
    const router = new Router(
      [
        { provider: 'openai', model: 'gpt-test', contextWindow: 900_000, maxOutputTokens: 32_000 },
        { provider: 'anthropic', model: 'claude-test', contextWindow: 1_000_000, maxOutputTokens: 32_000 },
      ],
      adapters,
    );
    const session = new Session(undefined, cwd, { persist: false });
    let streamed = '';
    await new Agent(session, router, new ToolEngine(), { cwd, approve: async () => true }).run('change the port to 8080', {
      onText: (d) => (streamed += d),
    });

    expect(readFileSync(join(cwd, 'app.ts'), 'utf8')).toContain('8080');
    expect(streamed).toBe('Checking.Port is now 8080.');

    // --- OpenAI Responses requests ------------------------------------------------
    const [oa1, oa2, oa3] = fake.requestsTo('/v1/responses') as Array<Item & { input: Item[] }>;
    expect(oa1).toMatchObject({ model: 'gpt-test', store: false, include: ['reasoning.encrypted_content'], stream: true, max_output_tokens: 32_000 });
    expect((oa1!.tools as Item[])[0]).toMatchObject({ type: 'function', name: 'read_file', strict: false });
    expect(typeof oa1!.instructions).toBe('string');

    // Turn 2: reasoning item replayed verbatim, before the call it produced, then the call's output.
    expect(oa2!.input.map((i) => i.type ?? `msg:${String(i.role)}`)).toEqual(['msg:user', 'reasoning', 'msg:assistant', 'function_call', 'function_call_output']);
    expect(oa2!.input[1]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC_OPENAI_1' });
    expect(oa2!.input[3]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'read_file' });
    expect(oa2!.input[4]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(String(oa2!.input[4]!.output)).toContain('export const port = 3000');
    expect(oa3!.input.filter((i) => i.type === 'reasoning')).toHaveLength(2);

    // --- Anthropic requests ------------------------------------------------------------
    const [an1, an2] = fake.requestsTo('/v1/messages') as Array<Item & { messages: Array<{ role: string; content: Block[] }> }>;
    const blocks1 = an1!.messages.flatMap((m) => m.content);
    // OpenAI's encrypted reasoning never reaches Claude; its tool history does.
    expect(JSON.stringify(an1)).not.toContain('ENC_OPENAI');
    expect(blocks1.filter((b) => b.type === 'tool_use').map((b) => b.name)).toEqual(['read_file', 'edit_file']);
    expect(blocks1.some((b) => b.type === 'thinking')).toBe(false);

    // Claude's own thinking comes back unchanged, ahead of its tool_use, within the tool loop.
    const lastAssistant = an2!.messages.filter((m) => m.role === 'assistant').at(-1)!;
    expect(lastAssistant.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(lastAssistant.content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'SIG_CLAUDE_1' });
  });

  it('classifies an in-stream Responses failure so the router can act on it', async () => {
    fake.on('/v1/responses', (_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', sequence_number: 1, response: { id: 'r', object: 'response', created_at: 0, status: 'failed', model: 'gpt-test', output: [], error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' }, incomplete_details: null } })}\n\n`);
    });
    fake.on('/v1/messages', (_b, res) => anthropicStream(res, [aText('fallback ok')], 'end_turn'));
    const router = new Router(
      [
        { provider: 'openai', model: 'gpt-test', contextWindow: 100_000, maxOutputTokens: 1_000 },
        { provider: 'anthropic', model: 'claude-test', contextWindow: 100_000, maxOutputTokens: 1_000 },
      ],
      new Map<string, ProviderAdapter>([
        ['openai', new OpenAIResponsesAdapter({ name: 'openai', apiKey: 'k', baseURL: `${fake.base}/v1` })],
        ['anthropic', new AnthropicAdapter({ name: 'anthropic', apiKey: 'k', baseURL: fake.base })],
      ]),
      { sameTargetRetries: 0 },
    );
    const session = new Session(undefined, tmpdir(), { persist: false });
    const kinds: string[] = [];
    await new Agent(session, router, new ToolEngine(), { cwd: tmpdir(), approve: async () => true }).run('hi', {
      onSwitch: (_f, _t, why) => kinds.push(why.kind),
    });
    expect(kinds).toEqual(['rate_limit']);
    expect(router.current.provider).toBe('anthropic');
  });
});
