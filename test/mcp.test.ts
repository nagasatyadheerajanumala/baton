import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/loop.js';
import { Session } from '../src/ir/session.js';
import { ToolBridge } from '../src/mcp/bridge.js';
import { runMcpCommand } from '../src/mcp/cli.js';
import { McpManager, exposedToolName } from '../src/mcp/client.js';
import { Router } from '../src/router/router.js';
import { ProcessManager } from '../src/tools/processes.js';
import { ToolEngine } from '../src/tools/registry.js';
import { ScriptedAdapter, text, toolCall } from './helpers.js';

const SERVER = resolve('test/fixtures/mcp-notes-server.mjs');
const notes = { command: process.execPath, args: [SERVER] };
const dir = () => mkdtempSync(join(tmpdir(), 'baton-mcp-'));
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('MCP client', () => {
  it('connects to a stdio server and exposes its tools, respecting read-only hints', async () => {
    const cwd = dir();
    const m = new McpManager({ notes }, cwd, dir());
    await m.connectAll();
    expect(m.servers[0]).toMatchObject({ status: 'connected' });
    const tools = m.tools();
    expect(tools.map((t) => t.spec.name)).toEqual(['mcp__notes__echo', 'mcp__notes__write_note']);
    expect(tools.map((t) => t.mutates)).toEqual([false, true]);
    const out = await tools[0]!.execute({ text: 'hi' }, { cwd, approve: async () => true, processes: new ProcessManager() });
    expect(out).toEqual({ content: 'echo: hi', isError: false });
    await m.close();
  });

  it('lets any model use MCP tools, asking permission only for ones that change things', async () => {
    const cwd = dir();
    const m = new McpManager({ notes }, cwd, dir());
    await m.connectAll();
    const model = new ScriptedAdapter('api', [
      toolCall('c1', 'mcp__notes__echo', { text: 'ping' }),
      toolCall('c2', 'mcp__notes__write_note', { note: 'remember the milk' }),
      text('done'),
    ]);
    const asked: string[] = [];
    const agent = new Agent(new Session(undefined, cwd, { persist: false }), new Router([{ provider: 'api', model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000 }], new Map([['api', model]])), new ToolEngine(), {
      cwd,
      mcp: m,
      approve: async (summary, call) => (asked.push(`${summary}|${call?.name}`), true),
    });
    await agent.run('take a note');
    expect(model.requests[0]!.tools.map((t) => t.name)).toContain('mcp__notes__write_note');
    expect(asked).toEqual(['notes · write_note {"note":"remember the milk"}|mcp__notes__write_note']);
    expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('remember the milk\n');
    await agent.close();
  });

  it('serves MCP tools to subscription CLIs through the bridge too', async () => {
    const cwd = dir();
    const m = new McpManager({ notes }, cwd, dir());
    await m.connectAll();
    const engine = new ToolEngine();
    engine.setMcpTools(m.tools());
    const bridge = new ToolBridge(engine);
    const url = await bridge.start();
    const list = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('mcp__notes__echo');
    await bridge.stop();
    await m.close();
  });

  it('reports a broken server and a server that needs sign-in, without failing the others', async () => {
    const http = createServer((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    const m = new McpManager({ notes, broken: { command: '/nonexistent/binary' }, remote: { type: 'http', url } }, dir(), dir());
    await m.connectAll(8_000);
    const byName = Object.fromEntries(m.servers.map((s) => [s.name, s]));
    expect(byName.notes!.status).toBe('connected');
    expect(byName.broken!.status).toBe('failed');
    expect(byName.remote!.status).toBe('needs-login');
    expect(byName.remote!.error).toContain('baton mcp login remote');
    await m.close();
    http.close();
  });

  it('keeps exposed names within provider limits', () => {
    expect(exposedToolName('my server', 'do.thing')).toBe('mcp__my_server__do_thing');
    expect(exposedToolName('a'.repeat(40), 'b'.repeat(40)).length).toBe(64);
  });
});

describe('baton mcp commands', () => {
  it('adds, lists, imports from Codex and the project, and removes servers', async () => {
    const home = dir();
    const cwd = dir();
    process.env.BATON_HOME = home;
    process.env.PATH = `${resolve('test/fixtures/bin')}:${process.env.PATH}`;
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['docs-mcp'] } } }));
    const out: string[] = [];
    const log = (s: string) => out.push(s.replace(/\x1b\[[0-9;]*m/g, ''));

    expect(await runMcpCommand(['add', 'notes', '--', process.execPath, SERVER], cwd, log)).toBe(0);
    expect(out.join('\n')).toMatch(/Added notes[\s\S]*connected · 2 tools/);

    out.length = 0;
    await runMcpCommand(['import'], cwd, log);
    const listing = out.join('\n');
    expect(listing).toMatch(/playwright\s+codex/);
    expect(listing).toMatch(/node_repl[\s\S]*built into Codex/);
    expect(listing).toMatch(/docs\s+project/);

    out.length = 0;
    expect(await runMcpCommand(['import', '--all'], cwd, log)).toBe(0);
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(Object.keys(config.mcpServers).sort()).toEqual(expect.arrayContaining(['docs', 'linear', 'notes', 'playwright']));
    expect(config.mcpServers.node_repl).toBeUndefined(); // built-ins skipped by --all
    expect(config.mcpServers.linear).toEqual({ type: 'http', url: 'https://mcp.linear.app/mcp' });
    expect(out.join('\n')).toContain('baton mcp login linear');

    expect(await runMcpCommand(['remove', 'docs'], cwd, log)).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).mcpServers.docs).toBeUndefined();
  });
});

describe('MCP sign-in (OAuth)', () => {
  it('signs in through the browser flow, saves tokens, and later connects without asking again', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { loginToServer } = await import('../src/mcp/client.js');
    const { statSync } = await import('node:fs');

    let base = '';
    const registered: string[] = [];
    const http = createServer(async (req, res) => {
      const u = new URL(req.url!, base);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (u.pathname === '/.well-known/oauth-authorization-server')
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      if (u.pathname === '/register') {
        let body = '';
        for await (const c of req) body += c;
        registered.push(body);
        return json(201, { ...JSON.parse(body), client_id: 'client-1' });
      }
      if (u.pathname === '/authorize') {
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'auth-code-1');
        if (u.searchParams.get('state')) back.searchParams.set('state', u.searchParams.get('state')!);
        return res.writeHead(302, { location: back.toString() }).end();
      }
      if (u.pathname === '/token') return json(200, { access_token: 'token-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 });
      if (u.pathname === '/mcp') {
        if (req.headers.authorization !== 'Bearer token-1') return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        const server = new Server({ name: 'remote', version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: {} } }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        let body = '';
        for await (const c of req) body += c;
        return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const authDir = dir();
    const config = { type: 'http' as const, url: `${base}/mcp` };

    // Before sign-in: reported, and no client registration happens in the background.
    const before = new McpManager({ remote: config }, dir(), authDir);
    await before.connectAll(5_000);
    expect(before.servers[0]!.status).toBe('needs-login');
    expect(registered).toHaveLength(0);

    // Sign in; the "browser" follows the authorize redirect back to baton's local callback.
    const logs: string[] = [];
    const ok = await loginToServer('remote', config, dir(), (s) => logs.push(s), authDir, (url) => void fetch(url));
    expect(ok).toBe(true);
    expect(logs.join('\n')).toContain('Signed in to remote: 1 tool available.');
    expect(registered).toHaveLength(1);
    expect(statSync(join(authDir, 'remote.json')).mode & 0o777).toBe(0o600); // tokens readable only by you

    // Next launch: connects with the saved token, no sign-in.
    const after = new McpManager({ remote: config }, dir(), authDir);
    await after.connectAll(5_000);
    expect(after.servers[0]).toMatchObject({ status: 'connected' });
    expect(after.tools().map((t) => t.spec.name)).toEqual(['mcp__remote__list_issues']);
    await after.close();
    http.close();
  });
});

describe('MCP catalog and registry', () => {
  it('maps registry entries to runnable configs, preferring remote endpoints', async () => {
    const { fromRegistry, shortName } = await import('../src/mcp/catalog.js');
    expect(shortName('com.notion/mcp')).toBe('notion');
    expect(shortName('io.github.getsentry/sentry-mcp')).toBe('sentry-mcp');
    expect(fromRegistry({ name: 'com.notion/mcp', description: 'Notion', remotes: [{ type: 'sse', url: 'https://x/sse' }, { type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }] }))
      .toMatchObject({ name: 'notion', config: { type: 'http', url: 'https://mcp.notion.com/mcp' } });
    expect(fromRegistry({ name: 'io.github.x/figma', packages: [{ registryType: 'npm', identifier: 'figma-developer-mcp', version: '1.2.0', environmentVariables: [{ name: 'FIGMA_API_KEY', isRequired: true }] }] }))
      .toMatchObject({ config: { command: 'npx', args: ['-y', 'figma-developer-mcp@1.2.0'], envVars: ['FIGMA_API_KEY'] }, needsEnv: ['FIGMA_API_KEY'] });
    expect(fromRegistry({ name: 'eu.x/stripe', remotes: [{ type: 'streamable-http', url: 'https://x/mcp/{token}' }] })).toBeUndefined(); // templated URLs can't be used as-is
  });

  it('ranks the publisher’s own server above wrappers and de-duplicates versions', async () => {
    const { searchRegistry } = await import('../src/mcp/catalog.js');
    const body = { servers: [
      { server: { name: 'ai.smithery/smithery-notion', description: 'wrapper', remotes: [{ type: 'streamable-http', url: 'https://server.smithery.ai/n/mcp' }] } },
      { server: { name: 'io.github.someone/notion-tools', description: 'third party', packages: [{ registryType: 'npm', identifier: 'notion-tools' }] } },
      { server: { name: 'com.notion/mcp', description: 'official', remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }] } },
      { server: { name: 'com.notion/mcp', description: 'official (older version)', remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }] } },
    ] };
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const results = await searchRegistry('notion', { fetchImpl });
    expect(results.map((r) => r.registryName)).toEqual(['com.notion/mcp', 'io.github.someone/notion-tools', 'ai.smithery/smithery-notion']);
  });

  it('adds, disables, re-enables and removes servers at runtime', async () => {
    const cwd = dir();
    const m = new McpManager({}, cwd, dir());
    const changes: number[] = [];
    m.on('change', () => changes.push(1));
    m.add('notes', { ...notes });
    expect((await m.connect('notes')).status).toBe('connected');
    expect(m.tools()).toHaveLength(2);
    await m.setEnabled('notes', false);
    expect(m.servers[0]).toMatchObject({ status: 'disabled', config: { enabled: false } });
    expect(m.tools()).toHaveLength(0);
    expect((await m.setEnabled('notes', true))?.status).toBe('connected');
    await m.remove('notes');
    expect(m.servers).toHaveLength(0);
    expect(changes.length).toBeGreaterThan(3);
    await m.close();
  });

  it('renders the panel: your servers with status, then things you can add', async () => {
    const { renderMcpPanel, mcpRows } = await import('../src/ui/tui/panels.js');
    const { POPULAR } = await import('../src/mcp/catalog.js');
    const sections = [
      { title: 'Your servers', rows: [{ kind: 'server' as const, name: 'linear', status: 'needs-login' as const, tools: 0, where: '' }, { kind: 'server' as const, name: 'playwright', status: 'connected' as const, tools: 25, where: '' }] },
      { title: 'Popular', rows: POPULAR.slice(0, 2).map((entry) => ({ kind: 'candidate' as const, entry })) },
    ];
    expect(mcpRows(sections)).toHaveLength(4);
    const text = renderMcpPanel({ query: '', searching: false, sections, cursor: 2 }, 110, 40).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(text).toMatch(/linear\s+needs sign-in · enter to sign in/);
    expect(text).toMatch(/playwright\s+connected · 25 tools/);
    expect(text).toMatch(/❯ \+ github\s+Repos, issues, pull requests/);
    expect(text).toContain('Type to search the MCP registry');
  });
});

describe('automatic discovery of servers set up in Codex and Claude Code', () => {
  it('picks up Codex servers, skips built-ins, excluded and already-configured names', async () => {
    const { discoverServers } = await import('../src/mcp/cli.js');
    delete process.env.BATON_NO_DISCOVERY;
    process.env.PATH = `${resolve('test/fixtures/bin')}:${process.env.PATH}`; // fake `codex mcp list --json`
    const found = await discoverServers(dir(), {
      providers: {},
      chain: [],
      mcpServers: { linear: { type: 'http', url: 'https://example.com/my-own-linear' } },
      mcpExclude: [],
      mcpImport: { codex: true, claude: false },
    });
    expect(found.map((c) => c.name)).toEqual(['playwright']); // linear is configured in baton already; node_repl is a Codex built-in
    const hidden = await discoverServers(dir(), { providers: {}, chain: [], mcpExclude: ['playwright'], mcpImport: { codex: true, claude: false } });
    expect(hidden.map((c) => c.name)).toEqual(['linear']);
  });

  it('stays off in tests and scripted runs', async () => {
    const { discoverServers } = await import('../src/mcp/cli.js');
    process.env.BATON_NO_DISCOVERY = '1';
    expect(await discoverServers(dir(), { providers: {}, chain: [] })).toEqual([]);
  });
});
