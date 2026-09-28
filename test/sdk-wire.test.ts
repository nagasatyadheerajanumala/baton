/**
 * Runs the real Anthropic and OpenAI SDK clients against a local server that
 * speaks both vendors' streaming wire formats. Catches what the scripted-adapter
 * tests cannot: request body shape, SSE parsing, and classification of the
 * SDKs' actual error classes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/loop.js';
import { Session } from '../src/ir/session.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import { OpenAIChatAdapter } from '../src/providers/openai.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { Router } from '../src/router/router.js';
import { ToolEngine } from '../src/tools/registry.js';

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;
const bodies: { path: string; body: Record<string, unknown> }[] = [];
const queue: Record<string, Handler[]> = { '/v1/chat/completions': [], '/v1/messages': [] };
let base = '';
const server = createServer(async (req: IncomingMessage, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}') as Record<string, unknown>;
  bodies.push({ path: req.url!, body });
  const next = queue[req.url!]?.shift();
  if (!next) {
    res.writeHead(500).end('unexpected request');
    return;
  }
  next(body, res);
});

const sse = (res: ServerResponse, events: Array<[string | null, unknown]>) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  res.end();
};

const openaiChunk = (delta: object, finish: string | null = null) => ({
  id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const anthropicStream = (blocks: Array<{ start: object; deltas: object[] }>, stop: string): Array<[string, unknown]> => [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } }],
  ...blocks.flatMap((b, index): Array<[string, unknown]> => [
    ['content_block_start', { type: 'content_block_start', index, content_block: b.start }],
    ...b.deltas.map((delta): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index, delta }]),
    ['content_block_stop', { type: 'content_block_stop', index }],
  ]),
  ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 17 } }],
  ['message_stop', { type: 'message_stop' }],
];

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('real SDKs over the wire', () => {
  it('streams an OpenAI tool call, fails over on a real 429 insufficient_quota, and continues on Anthropic', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'baton-wire-'));
    writeFileSync(join(cwd, 'greet.ts'), 'export const greet = () => "hello";\n');
    execFileSync('git', ['init', '-q'], { cwd });

    // OpenAI turn 1: streamed tool call with an id containing chars Anthropic rejects.
    queue['/v1/chat/completions']!.push((_b, res) =>
      sse(res, [
        [null, openaiChunk({ role: 'assistant', content: 'Reading.' })],
        [null, openaiChunk({ tool_calls: [{ index: 0, id: 'call:xyz.1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] })],
        [null, openaiChunk({ tool_calls: [{ index: 0, function: { arguments: '"greet.ts"}' } }] }, 'tool_calls')],
        [null, { ...openaiChunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } }],
        [null, '[DONE]'],
      ]),
    );
    // OpenAI turn 2: quota exhausted, exactly as OpenAI sends it.
    queue['/v1/chat/completions']!.push((_b, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }));
    });
    // Anthropic turn 1: tool_use with streamed JSON input. Turn 2: final text.
    queue['/v1/messages']!.push((_b, res) =>
      sse(res, anthropicStream([
        { start: { type: 'tool_use', id: 'toolu_01', name: 'edit_file', input: {} }, deltas: [
          { type: 'input_json_delta', partial_json: '{"path":"greet.ts","old_string":"\\"hello\\"",' },
          { type: 'input_json_delta', partial_json: '"new_string":"\\"hi\\""}' },
        ] },
      ], 'tool_use')),
    );
    queue['/v1/messages']!.push((_b, res) =>
      sse(res, anthropicStream([{ start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: 'Updated ' }, { type: 'text_delta', text: 'greet.ts.' }] }], 'end_turn')),
    );

    const adapters = new Map<string, ProviderAdapter>([
      ['openai', new OpenAIChatAdapter({ name: 'openai', apiKey: 'sk-test', baseURL: `${base}/v1`, maxTokensParam: 'max_completion_tokens' })],
      ['anthropic', new AnthropicAdapter({ name: 'anthropic', apiKey: 'sk-ant-test', baseURL: base })],
    ]);
    const router = new Router(
      [
        { provider: 'openai', model: 'gpt-test', contextWindow: 100_000, maxOutputTokens: 2_000 },
        { provider: 'anthropic', model: 'claude-test', contextWindow: 100_000, maxOutputTokens: 2_000 },
      ],
      adapters,
    );
    const session = new Session(undefined, cwd, { persist: false });
    let streamed = '';
    const switches: string[] = [];
    await new Agent(session, router, new ToolEngine(), { cwd, approve: async () => true }).run('rename hello to hi', {
      onText: (d) => (streamed += d),
      onSwitch: (_f, t, why) => switches.push(`${t.provider}:${why.kind}`),
    });

    expect(switches).toEqual(['anthropic:quota']);
    expect(streamed).toBe('Reading.Updated greet.ts.');

    // OpenAI request shape.
    const oa = bodies.find((b) => b.path === '/v1/chat/completions')!.body;
    expect(oa.max_completion_tokens).toBe(2_000);
    expect(oa.stream).toBe(true);
    expect((oa.tools as Array<{ type: string }>)[0]!.type).toBe('function');

    // Anthropic received OpenAI's history, translated, with the id sanitized on both sides.
    const an = bodies.filter((b) => b.path === '/v1/messages')[0]!.body;
    const msgs = an.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const toolUse = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_use')!;
    const toolResult = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_result')!;
    expect(toolUse).toMatchObject({ id: 'call_xyz_1', name: 'read_file', input: { path: 'greet.ts' } });
    expect(toolResult.tool_use_id).toBe('call_xyz_1');
    expect(String(toolResult.content)).toContain('export const greet');
    expect((an.system as Array<{ text: string }>)[0]!.text).toContain('Session handoff');

    // Usage from both vendors' streams landed on the right messages.
    const usage = session.messages.filter((m) => m.role === 'assistant').map((m) => m.meta.usage);
    expect(usage).toEqual([
      { inputTokens: 100, outputTokens: 12, cachedInputTokens: 0 },
      { inputTokens: 42, outputTokens: 17, cachedInputTokens: 0 },
      { inputTokens: 42, outputTokens: 17, cachedInputTokens: 0 },
    ]);
  });
});
