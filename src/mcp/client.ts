import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Tool } from '../tools/types.js';

/** One MCP server, in the same shape Claude Code's .mcp.json uses (plus a few Codex-style extras). */
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Names of environment variables to pass through to a stdio server. */
  envVars?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Env var holding a bearer token for an HTTP server. */
  bearerTokenEnv?: string;
  enabled?: boolean;
  /** Per-call timeout (default 600s). */
  toolTimeoutSec?: number;
}

export type McpStatus = 'connecting' | 'connected' | 'needs-login' | 'failed' | 'disabled';

export interface McpToolInfo {
  server: string;
  name: string;
  /** Name the models see: mcp__server__tool (sanitized, ≤64 chars). */
  exposedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export type McpOrigin = 'baton' | 'codex' | 'claude';

export interface McpServerState {
  name: string;
  config: McpServerConfig;
  /** Where the server is configured: baton's own config, or discovered from Codex / Claude Code. */
  origin: McpOrigin;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
}

export const mcpAuthDir = (env: NodeJS.ProcessEnv = process.env) => join(env.BATON_HOME ?? join(homedir(), '.baton'), 'mcp-auth');

const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
export const exposedToolName = (server: string, tool: string) => `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);

export function transportKind(c: McpServerConfig): 'stdio' | 'http' | 'sse' {
  return c.type ?? (c.url ? 'http' : 'stdio');
}

// ---- OAuth -------------------------------------------------------------------------

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/**
 * OAuth for remote MCP servers (Linear, Figma, ...). baton does its own
 * sign-in per server and keeps the tokens in ~/.baton/mcp-auth/<server>.json
 * (mode 600); it never reuses another app's tokens. Non-interactive
 * connections just report "needs-login"; `baton mcp login <name>` runs the
 * browser flow.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private readonly file: string;
  /** Set by the login flow; absent means "don't start a browser flow". */
  onAuthorize?: (url: URL) => void;

  constructor(
    readonly server: string,
    private redirect: string = 'http://127.0.0.1:33418/callback',
    dir: string = mcpAuthDir(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, `${clean(server)}.json`);
  }

  setRedirect(url: string): void {
    this.redirect = url;
  }
  get redirectUrl(): string {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'baton',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private read(): StoredAuth {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as StoredAuth;
    } catch {
      return {};
    }
  }
  private write(patch: Partial<StoredAuth>): void {
    writeFileSync(this.file, JSON.stringify({ ...this.read(), ...patch }, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  clientInformation() {
    return this.read().clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.write({ clientInformation: info });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
  }
  saveCodeVerifier(codeVerifier: string) {
    this.write({ codeVerifier });
  }
  codeVerifier() {
    const v = this.read().codeVerifier;
    if (!v) throw new Error('No PKCE code verifier saved');
    return v;
  }
  redirectToAuthorization(url: URL) {
    this.onAuthorize?.(url);
  }
  /** Forget the registered client (redirect ports change between logins). */
  resetClient() {
    this.write({ clientInformation: undefined, codeVerifier: undefined });
  }
  hasTokens(): boolean {
    return existsSync(this.file) && Boolean(this.read().tokens);
  }
}

// ---- Manager -------------------------------------------------------------------------

function buildTransport(name: string, c: McpServerConfig, cwd: string, auth?: FileOAuthProvider): Transport {
  const kind = transportKind(c);
  if (kind === 'stdio') {
    if (!c.command) throw new Error('stdio server needs "command"');
    const env: Record<string, string> = {};
    // A minimal, predictable environment: PATH/HOME plus what the server asks for.
    for (const k of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', ...(c.envVars ?? [])]) if (process.env[k]) env[k] = process.env[k]!;
    Object.assign(env, c.env);
    return new StdioClientTransport({ command: c.command, args: c.args ?? [], env, cwd: c.cwd ?? cwd, stderr: 'ignore' });
  }
  if (!c.url) throw new Error(`${kind} server needs "url"`);
  const headers: Record<string, string> = { ...c.headers };
  if (c.bearerTokenEnv && process.env[c.bearerTokenEnv]) headers.Authorization = `Bearer ${process.env[c.bearerTokenEnv]}`;
  const opts = { requestInit: { headers }, authProvider: headers.Authorization ? undefined : auth };
  return kind === 'sse' ? new SSEClientTransport(new URL(c.url), opts) : new StreamableHTTPClientTransport(new URL(c.url), opts);
}

function resultText(result: { content?: unknown; structuredContent?: unknown; toolResult?: unknown }): string {
  const content = (result.content ?? []) as Array<Record<string, unknown>>;
  const parts = content.map((c) => {
    if (c.type === 'text') return String(c.text ?? '');
    if (c.type === 'image' || c.type === 'audio') return `[${c.type}: ${String(c.mimeType ?? 'binary')}]`;
    if (c.type === 'resource') {
      const r = c.resource as Record<string, unknown> | undefined;
      return r?.text ? String(r.text) : `[resource: ${String(r?.uri ?? '')}]`;
    }
    if (c.type === 'resource_link') return `[link: ${String(c.uri ?? '')}]`;
    return JSON.stringify(c);
  });
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  if (parts.length === 0 && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult, null, 2));
  return parts.join('\n') || '(no output)';
}

/**
 * Connects to configured MCP servers and turns their tools into baton tools,
 * so every model in the chain (API or subscription CLI) can use them and
 * switching providers never loses them. Emits `change` as servers connect.
 */
export class McpManager extends EventEmitter {
  private readonly states = new Map<string, McpServerState>();
  private readonly clients = new Map<string, Client>();

  constructor(
    servers: Record<string, McpServerConfig>,
    private readonly cwd: string,
    private readonly authDir: string = mcpAuthDir(),
  ) {
    super();
    for (const [name, config] of Object.entries(servers)) {
      this.states.set(name, { name, config, origin: 'baton', status: config.enabled === false ? 'disabled' : 'connecting', tools: [] });
    }
  }

  get servers(): McpServerState[] {
    return [...this.states.values()];
  }

  /** Connect every enabled server in parallel; never throws. */
  async connectAll(timeoutMs = 20_000): Promise<void> {
    await Promise.all(this.servers.filter((s) => s.status !== 'disabled').map((s) => this.connect(s.name, timeoutMs)));
  }

  /** Add a server at runtime (e.g. from the /mcp panel); call connect() next. */
  add(name: string, config: McpServerConfig, origin: McpOrigin = 'baton'): McpServerState {
    const state: McpServerState = { name, config, origin, status: config.enabled === false ? 'disabled' : 'connecting', tools: [] };
    this.states.set(name, state);
    this.emit('change');
    return state;
  }

  async remove(name: string): Promise<void> {
    await this.disconnect(name);
    this.states.delete(name);
    this.emit('change');
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpServerState | undefined> {
    const state = this.states.get(name);
    if (!state) return undefined;
    if (enabled) {
      delete state.config.enabled;
      return this.connect(name);
    }
    state.config.enabled = false;
    await this.disconnect(name);
    state.status = 'disabled';
    state.tools = [];
    this.emit('change');
    return state;
  }

  private async disconnect(name: string): Promise<void> {
    await this.clients.get(name)?.close().catch(() => {});
    this.clients.delete(name);
  }

  async connect(name: string, timeoutMs = 20_000, auth?: FileOAuthProvider): Promise<McpServerState> {
    const state = this.states.get(name);
    if (!state) throw new Error(`No MCP server "${name}"`);
    await this.disconnect(name);
    state.status = 'connecting';
    state.error = undefined;
    this.emit('change');
    // Only use OAuth here if we already hold tokens (so refresh works). Starting a sign-in
    // flow is reserved for `baton mcp login`: a background connect must never register
    // clients or open browsers.
    const saved = transportKind(state.config) === 'stdio' ? undefined : new FileOAuthProvider(name, undefined, this.authDir);
    const provider = auth ?? (saved?.hasTokens() ? saved : undefined);
    const client = new Client({ name: 'baton', version: '0.1.0' });
    let timer: NodeJS.Timeout | undefined;
    try {
      const transport = buildTransport(name, state.config, this.cwd, provider);
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs))),
      ]);
      const listed = await client.listTools();
      state.tools = listed.tools.map((t) => ({
        server: name,
        name: t.name,
        exposedName: exposedToolName(name, t.name),
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        readOnly: t.annotations?.readOnlyHint === true,
      }));
      state.status = 'connected';
      this.clients.set(name, client);
    } catch (err) {
      await client.close().catch(() => {});
      const msg = String((err as Error).message ?? '');
      const code = (err as { code?: number }).code;
      if (err instanceof UnauthorizedError || code === 401 || code === 403 || /unauthori[sz]ed|\b401\b|\b403\b|invalid_token|forbidden/i.test(msg)) {
        state.status = 'needs-login';
        state.error = `sign in with: baton mcp login ${name}`;
      } else {
        state.status = 'failed';
        state.error = msg.split('\n')[0] || (err as Error).name || 'connection failed';
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.emit('change');
    return state;
  }

  /** baton tools for every connected server's tools. */
  tools(): Tool[] {
    return this.servers.flatMap((s) =>
      s.status !== 'connected'
        ? []
        : s.tools.map((info): Tool => ({
            spec: {
              name: info.exposedName,
              description: `[${info.server} MCP] ${info.description}`.slice(0, 1024),
              inputSchema: { type: 'object', properties: {}, ...info.inputSchema } as Tool['spec']['inputSchema'],
            },
            mutates: !info.readOnly,
            describe: (input) => `${info.server} · ${info.name} ${JSON.stringify(input).slice(0, 120)}`,
            execute: async (input, ctx) => {
              const client = this.clients.get(info.server);
              if (!client) return { content: `MCP server "${info.server}" is not connected.`, isError: true };
              const timeout = (s.config.toolTimeoutSec ?? 600) * 1000;
              const result = await client.callTool({ name: info.name, arguments: input }, undefined, { timeout, signal: ctx.signal });
              return { content: resultText(result as Parameters<typeof resultText>[0]), isError: result.isError === true };
            },
          })),
    );
  }

  /** Server and tool behind an exposed name, for display. */
  lookup(exposedName: string): McpToolInfo | undefined {
    for (const s of this.states.values()) for (const t of s.tools) if (t.exposedName === exposedName) return t;
    return undefined;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
}

// ---- Interactive sign-in -----------------------------------------------------------

function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** `baton mcp login <name>`: browser OAuth flow with a one-shot localhost callback. */
export async function loginToServer(
  name: string,
  config: McpServerConfig,
  cwd: string,
  log: (s: string) => void,
  authDir = mcpAuthDir(),
  openUrl: (url: string) => void = openInBrowser,
): Promise<boolean> {
  if (transportKind(config) === 'stdio') {
    log(`"${name}" is a local (stdio) server; it doesn't use sign-in.`);
    return false;
  }
  let server: Server | undefined;
  const code = new Promise<string>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') return void res.writeHead(404).end();
      const c = url.searchParams.get('code');
      const e = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<p style="font-family:sans-serif">${c ? 'Signed in. You can close this tab and return to baton.' : `Sign-in failed: ${e ?? 'no code'}`}</p>`);
      if (c) resolve(c);
      else reject(new Error(e ?? 'no authorization code'));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/callback`;
  const provider = new FileOAuthProvider(name, redirect, authDir);
  provider.resetClient();
  provider.onAuthorize = (url) => {
    log(`Opening your browser to sign in to ${name}…\nIf it doesn't open, visit:\n  ${url.toString()}`);
    openUrl(url.toString());
  };
  try {
    const transport = buildTransport(name, config, cwd, provider) as StreamableHTTPClientTransport | SSEClientTransport;
    const client = new Client({ name: 'baton', version: '0.1.0' });
    try {
      await client.connect(transport);
      log(`${name} is already signed in.`);
      await client.close();
      return true;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }
    const authCode = await Promise.race([code, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timed out waiting for sign-in (5 min)')), 300_000))]);
    await transport.finishAuth(authCode);
    const manager = new McpManager({ [name]: config }, cwd, authDir);
    const state = await manager.connect(name);
    await manager.close();
    if (state.status !== 'connected') throw new Error(state.error ?? state.status);
    log(`Signed in to ${name}: ${state.tools.length} tool${state.tools.length === 1 ? '' : 's'} available.`);
    return true;
  } finally {
    server?.close();
  }
}
