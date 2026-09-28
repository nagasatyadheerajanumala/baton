import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/loop.js';
import { Session } from '../src/ir/session.js';
import { isToolCall, isToolResult } from '../src/ir/types.js';
import { toAnthropicMessages } from '../src/providers/anthropic.js';
import { toOpenAIMessages } from '../src/providers/openai.js';
import { Router, type Target } from '../src/router/router.js';
import { ToolEngine } from '../src/tools/registry.js';
import { ScriptedAdapter, quotaError, text, toolCall } from './helpers.js';

const targets: Target[] = [
  { provider: 'openai', model: 'gpt-test', contextWindow: 100_000, maxOutputTokens: 4_000 },
  { provider: 'anthropic', model: 'claude-test', contextWindow: 100_000, maxOutputTokens: 4_000 },
];

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'baton-e2e-'));
  writeFileSync(join(dir, 'greet.ts'), 'export const greet = () => "hello";\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('hot-swap mid-task', () => {
  it('fails over from OpenAI to Anthropic on quota exhaustion without losing tool state', async () => {
    const cwd = project();
    const openai = new ScriptedAdapter('openai', [
      toolCall('call_abc.123', 'read_file', { path: 'greet.ts' }, 'Let me look at the file.'),
      toolCall('call_def', 'edit_file', { path: 'greet.ts', old_string: '"hello"', new_string: '"hello, world"' }),
      quotaError(), // dies right after its edit landed
    ]);
    const anthropic = new ScriptedAdapter('anthropic', [
      toolCall('toolu_01', 'bash', { command: 'cat greet.ts' }),
      text('Done: greet() now returns "hello, world".'),
    ]);

    const switches: string[] = [];
    const session = new Session(undefined, cwd, { persist: false });
    const router = new Router(targets, new Map([['openai', openai], ['anthropic', anthropic]]));
    const agent = new Agent(session, router, new ToolEngine(), { cwd, approve: async () => true });

    await agent.run('Make greet say hello, world', {
      onSwitch: (from, to, why) => switches.push(`${from.provider}->${to.provider}:${why.kind}`),
    });

    // The edit made by the first provider is on disk; the second one continued from it.
    expect(readFileSync(join(cwd, 'greet.ts'), 'utf8')).toContain('"hello, world"');
    expect(switches).toEqual(['openai->anthropic:quota']);
    expect(router.current.provider).toBe('anthropic');
    expect(session.switches).toHaveLength(1);

    // Anthropic's first request carried OpenAI's full tool history...
    const handoff = anthropic.requests[0]!;
    const calls = handoff.messages.flatMap((m) => m.content.filter(isToolCall)).map((c) => c.name);
    expect(calls).toEqual(['read_file', 'edit_file']);
    // ...plus a handoff note with fresh git ground truth.
    expect(handoff.system).toContain('Session handoff');
    expect(handoff.system).toContain('openai/gpt-test');
    expect(handoff.system).toContain('greet.ts'); // touched files + git status
    expect(handoff.system).toMatch(/M greet\.ts/);

    // The history translates cleanly into both wire formats, ids sanitized consistently.
    const wireA = toAnthropicMessages(handoff.messages);
    const uses = wireA.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use');
    const results = wireA.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    expect(uses.map((u) => (u as { id: string }).id)).toEqual(['call_abc_123', 'call_def']);
    expect(results.map((r) => (r as { tool_use_id: string }).tool_use_id)).toEqual(['call_abc_123', 'call_def']);
    expect(() => toOpenAIMessages('sys', session.messages)).not.toThrow();

    // Every call in the final session is answered exactly once.
    const allCalls = session.messages.flatMap((m) => m.content.filter(isToolCall)).map((c) => c.id);
    const allResults = session.messages.flatMap((m) => m.content.filter(isToolResult)).map((r) => r.callId);
    expect(allResults).toEqual(allCalls);

    // Assistant turns are attributed to the model that actually produced them.
    const producers = session.messages.filter((m) => m.role === 'assistant').map((m) => m.meta.provider);
    expect(producers).toEqual(['openai', 'openai', 'anthropic', 'anthropic']);
  });

  it('does not repeat the handoff git snapshot after the first post-switch call', async () => {
    const cwd = project();
    const openai = new ScriptedAdapter('openai', [quotaError()]);
    const anthropic = new ScriptedAdapter('anthropic', [toolCall('t1', 'git_status', {}), text('ok')]);
    const session = new Session(undefined, cwd, { persist: false });
    // Seed a prior OpenAI turn so there is someone to hand off from.
    session.push({ id: 'u0', role: 'user', content: [{ type: 'text', text: 'hi' }], meta: { ts: 0 } });
    session.push({ id: 'a0', role: 'assistant', content: [{ type: 'text', text: 'hello' }], meta: { ts: 0, provider: 'openai', model: 'gpt-test' } });

    const router = new Router(targets, new Map([['openai', openai], ['anthropic', anthropic]]));
    await new Agent(session, router, new ToolEngine(), { cwd, approve: async () => true }).run('status?');

    expect(anthropic.requests[0]!.system).toContain('Current git state');
    expect(anthropic.requests[1]!.system).toContain('Session handoff');
    expect(anthropic.requests[1]!.system).not.toContain('Current git state');
  });
});
