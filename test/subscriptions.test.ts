import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/loop.js';
import { configFromEnv, detectSubscriptions } from '../src/config/config.js';
import { runDoctor } from '../src/doctor.js';
import { Session } from '../src/ir/session.js';
import { isToolCall } from '../src/ir/types.js';
import { ToolBridge } from '../src/mcp/bridge.js';
import { ClaudeCodeAdapter } from '../src/providers/cli/claude-code.js';
import { CodexAdapter } from '../src/providers/cli/codex.js';
import { cliError } from '../src/providers/cli/common.js';
import { buildExternalPrompt } from '../src/providers/cli/transcript.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { classifyError } from '../src/router/errors.js';
import { Router, type Target } from '../src/router/router.js';
import { ProcessManager } from '../src/tools/processes.js';
import { ToolEngine } from '../src/tools/registry.js';
import { ScriptedAdapter, quotaError, text, toolCall } from './helpers.js';

const BIN = resolve('test/fixtures/bin');
const PATH_WITH_FAKES = `${BIN}:${process.env.PATH}`;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'baton-sub-'));
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  return dir;
}

const savedEnv = { ...process.env };
function useFakes(env: Record<string, string>) {
  Object.assign(process.env, { PATH: PATH_WITH_FAKES, CODEX_HOME: mkdtempSync(join(tmpdir(), 'codex-home-')), ...env });
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const T = (provider: string, model = 'm'): Target => ({ provider, model, contextWindow: 200_000, maxOutputTokens: 8_000 });

describe('MCP tool bridge', () => {
  it('speaks MCP over HTTP, runs tools through the engine, and records each step', async () => {
    const cwd = project();
    const bridge = new ToolBridge(new ToolEngine());
    const url = await bridge.start();
    const session = new Session(undefined, cwd, { persist: false });
    bridge.attach({ session, events: {}, ctx: { cwd, approve: async () => true, processes: new ProcessManager() }, producer: () => ({ provider: 'claude', model: 'opus' }) });
    const rpc = async (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'baton' }, capabilities: { tools: {} } });
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('edit_file');

    const call = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } })).json();
    expect(call.result).toMatchObject({ isError: false });
    expect(call.result.content[0].text).toContain('hello');
    const calls = session.messages.flatMap((m) => m.content.filter(isToolCall));
    expect(calls).toEqual([expect.objectContaining({ name: 'read_file' })]);
    expect(session.messages[0]!.meta).toMatchObject({ provider: 'claude', model: 'opus', subscription: true });

    // Wrong secret: other local processes can't reach baton's tools.
    expect((await fetch(url.replace(/\/mcp\/.+$/, '/mcp/guess'), { method: 'POST', body: '{}' })).status).toBe(404);
    await bridge.stop();
  });
});

describe('subscription CLI errors', () => {
  it.each([
    ['Claude AI usage limit reached|' + (Math.floor(Date.now() / 1000) + 3600), 'quota'],
    ["You've hit your usage limit. Upgrade to Pro or try again in 2 hours.", 'quota'],
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth'],
    ['codex is not installed', 'fatal'],
    ['API Error: 529 Overloaded', 'overloaded'],
  ])('%s -> %s', (msg, kind) => {
    expect(classifyError(cliError(msg, 'X')).kind).toBe(kind);
  });

  it('carries the reset time so the router cools down for the right duration', () => {
    const why = classifyError(cliError("You've hit your usage limit. Try again in 2 hours.", 'Codex'));
    expect(why.retryAfterMs).toBe(2 * 3_600_000);
  });
});

describe('handoff prompt into an agent CLI', () => {
  it('passes prior work as a transcript and the latest human message as the request', () => {
    const s = new Session(undefined, '/', { persist: false });
    s.push({ id: '1', role: 'user', content: [{ type: 'text', text: 'fix add()' }], meta: { ts: 0 } });
    s.push({ id: '2', role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'read_file', input: { path: 'math.js' } }], meta: { ts: 0, model: 'gpt-6-sol' } });
    s.push({ id: '3', role: 'user', content: [{ type: 'tool_result', callId: 'c', content: 'return a - b;' }], meta: { ts: 0 } });
    const mid = buildExternalPrompt(s.messages, true);
    expect(mid).toContain('taking over a coding session');
    expect(mid).toContain('[tool call] read_file {"path":"math.js"}');
    expect(mid).toContain('return a - b;');
    expect(mid).toMatch(/Continue the task from exactly where the transcript leaves off/);

    s.push({ id: '4', role: 'user', content: [{ type: 'text', text: 'now add multiply' }], meta: { ts: 0 } });
    expect(buildExternalPrompt([s.messages[3]!], false)).toBe('now add multiply');
  });
});

describe('Claude Code and Codex as providers (fake CLIs)', () => {
  for (const kind of ['claude', 'codex'] as const) {
    it(`${kind}: runs a turn through baton's tools, streams text, records steps, resumes its session`, async () => {
      const cwd = project();
      const log = join(cwd, 'cli.log');
      useFakes({ FAKE_CLI_LOG: log });
      const adapter: ProviderAdapter = kind === 'claude' ? new ClaudeCodeAdapter({ name: 'sub' }) : new CodexAdapter({ name: 'sub' });
      const router = new Router([T('sub', kind === 'claude' ? 'claude-opus-5-5' : 'gpt-6-astra')], new Map([['sub', adapter]]));
      const session = new Session(undefined, cwd, { persist: false });
      const agent = new Agent(session, router, new ToolEngine(), { cwd, approve: async () => true });
      let streamed = '';
      const tools: string[] = [];

      await agent.run('write out.txt', { onText: (d) => (streamed += d), onToolStart: (c) => tools.push(c.name) });
      expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe(`from ${kind}\n`);
      expect(streamed).toContain('Done.');
      expect(tools).toContain('write_file');
      if (kind === 'codex') expect(tools).toContain('bash'); // its read-only `ls` is recorded too

      const final = session.messages.at(-1)!;
      expect(final.meta).toMatchObject({ provider: 'sub', subscription: true });
      expect(final.content).toEqual([{ type: 'text', text: expect.stringContaining('Done.') }]);

      await agent.run('again');
      const runs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string });
      expect(runs).toHaveLength(2);
      expect(runs[1]!.args).toContain(kind === 'claude' ? '--resume' : 'resume');
      expect(runs[1]!.prompt).toBe('again'); // it already has turn 1 in its own session
      if (kind === 'claude') {
        expect(runs[0]!.args).toEqual(expect.arrayContaining(['--tools', '', '--strict-mcp-config', '--allowedTools', 'mcp__baton']));
      } else {
        expect(runs[0]!.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '-c', 'mcp_servers.baton.default_tools_approval_mode="approve"']));
      }
      await agent.close();
    });
  }

  it('fails over from a plan at its usage limit to an API key, keeping the work', async () => {
    const cwd = project();
    useFakes({ FAKE_CLAUDE_MODE: 'limit' });
    const api = new ScriptedAdapter('api', [toolCall('c1', 'read_file', { path: 'a.txt' }), text('finished on the API')]);
    const router = new Router([T('claude', 'claude-opus-5-5'), T('api', 'claude-sonnet-5-5')], new Map<string, ProviderAdapter>([['claude', new ClaudeCodeAdapter({ name: 'claude' })], ['api', api]]));
    const switches: string[] = [];
    const agent = new Agent(new Session(undefined, cwd, { persist: false }), router, new ToolEngine(), { cwd, approve: async () => true });
    await agent.run('do it', { onSwitch: (_f, t, why) => switches.push(`${t.provider}:${why.kind}`) });
    expect(switches).toEqual(['api:quota']);
    expect(router.cooldownRemaining(router.chain[0]!)).toBeGreaterThan(50 * 60_000); // resets in ~1h per the CLI
    await agent.close();
  });

  it('hands off from an API model into Codex mid-task with a transcript', async () => {
    const cwd = project();
    const log = join(cwd, 'cli.log');
    useFakes({ FAKE_CLI_LOG: log });
    const api = new ScriptedAdapter('api', [toolCall('c1', 'read_file', { path: 'a.txt' }), quotaError()]);
    const router = new Router([T('api', 'gpt-6-sol'), T('chatgpt', 'gpt-6-astra')], new Map<string, ProviderAdapter>([['api', api], ['chatgpt', new CodexAdapter({ name: 'chatgpt' })]]));
    const agent = new Agent(new Session(undefined, cwd, { persist: false }), router, new ToolEngine(), { cwd, approve: async () => true });
    await agent.run('update the file');
    const [run] = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { prompt: string });
    expect(run!.prompt).toContain('<instructions>');
    expect(run!.prompt).toContain('Session handoff'); // system prompt incl. handoff note rides along
    expect(run!.prompt).toContain('[tool call] read_file {"path":"a.txt"}');
    expect(run!.prompt).toContain('hello'); // the read result, so Codex needn't redo it
    await agent.close();
  });
});

describe('detection and doctor', () => {
  it('detects signed-in CLIs by asking them, and puts subscriptions first in the default chain', () => {
    useFakes({});
    const subs = detectSubscriptions(process.env);
    expect(subs.claude).toMatchObject({ installed: true, loggedIn: true });
    expect(subs.codex).toMatchObject({ installed: true, loggedIn: true });
    const cfg = configFromEnv({ OPENAI_API_KEY: 'k' }, subs);
    expect(cfg.chain.map((t) => t.provider)).toEqual(['chatgpt', 'claude', 'openai']);
    expect(cfg.providers.claude).toEqual({ type: 'claude-code' });
  });

  it('doctor verifies a subscription end to end and explains a signed-out CLI', async () => {
    useFakes({ FAKE_CODEX_MODE: 'logged-out' });
    const lines: string[] = [];
    const code = await runDoctor(
      { providers: { claude: { type: 'claude-code' }, chatgpt: { type: 'codex' } }, chain: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'chatgpt', model: 'gpt-6-astra' }] },
      'test',
      (s) => lines.push(strip(s)),
      process.env,
    );
    const out = lines.join('\n');
    expect(out).toMatch(/✓ claude\/claude-opus-5-5\n\s+signed in · baton's tools reachable over MCP · answered/);
    expect(out).toMatch(/✗ chatgpt\/gpt-6-astra\n\s+Codex isn't signed in\.\n\s+run: codex login/);
    expect(code).toBe(1);
  });
});
