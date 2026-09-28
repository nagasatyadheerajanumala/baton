import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentEvents } from '../agent/loop.js';
import { type Session, newMessage } from '../ir/session.js';
import type { ToolCallBlock, ToolResultBlock } from '../ir/types.js';
import type { ToolEngine } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

/** Who is currently driving tools through the bridge, and where to record what happens. */
export interface BridgeTurn {
  session: Session;
  events: AgentEvents;
  ctx: ToolContext;
  /** Attribution for recorded assistant steps. */
  producer: () => { provider: string; model: string };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Serves baton's tool engine to an external agent CLI (Claude Code, Codex)
 * as a Streamable HTTP MCP server on 127.0.0.1. The URL carries a random
 * secret so other local processes can't call baton's tools.
 *
 * Every call goes through the same ToolEngine as API providers (approvals,
 * process manager, UI events) and is recorded into the session as ordinary
 * tool_call / tool_result messages, so a later provider switch sees it all.
 */
export class ToolBridge {
  private server: Server | undefined;
  private secret = randomBytes(18).toString('base64url');
  private turn: BridgeTurn | undefined;
  private callSeq = 0;
  /** Ids of messages recorded since attach(), so a CLI adapter can mark them as seen. */
  recorded: string[] = [];
  url = '';

  constructor(
    private readonly tools: ToolEngine,
    private readonly version = '0.1.0',
  ) {}

  async start(): Promise<string> {
    if (this.server) return this.url;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp/${this.secret}`;
    return this.url;
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    return new Promise((r) => (s ? s.close(() => r()) : r()));
  }

  attach(turn: BridgeTurn): void {
    this.turn = turn;
    this.recorded = [];
  }
  detach(): void {
    this.turn = undefined;
  }

  /** Record assistant prose the external agent produced between tool calls. */
  recordText(text: string): void {
    const t = this.turn;
    if (!t || !text.trim()) return;
    this.push(t, newMessage('assistant', [{ type: 'text', text }], { ...t.producer(), subscription: true }));
  }

  /**
   * Record a tool the external agent ran itself (e.g. Codex's read-only shell),
   * so it appears in the UI and in history for the next provider.
   */
  recordExternal(name: string, input: Record<string, unknown>, output: string, isError = false): void {
    const t = this.turn;
    if (!t) return;
    const call: ToolCallBlock = { type: 'tool_call', id: `ext_${++this.callSeq}_${Date.now()}`, name, input };
    const result: ToolResultBlock = { type: 'tool_result', callId: call.id, content: output, ...(isError ? { isError } : {}) };
    t.events.onToolStart?.(call, name);
    this.push(t, newMessage('assistant', [call], { ...t.producer(), subscription: true }));
    t.events.onToolEnd?.(call, result);
    this.push(t, newMessage('user', [result]));
  }

  private push(t: BridgeTurn, m: ReturnType<typeof newMessage>): void {
    t.session.push(m);
    this.recorded.push(m.id);
  }

  get cwd(): string | undefined {
    return this.turn?.ctx.cwd;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolResultBlock> {
    const t = this.turn;
    const call: ToolCallBlock = { type: 'tool_call', id: `mcp_${++this.callSeq}_${Date.now()}`, name, input: args };
    if (!t) return { type: 'tool_result', callId: call.id, content: 'baton is not running a turn right now.', isError: true };
    this.push(t, newMessage('assistant', [call], { ...t.producer(), subscription: true }));
    t.events.onToolStart?.(call, this.tools.describe(call));
    const result = await this.tools.run(call, t.ctx);
    t.events.onToolEnd?.(call, result);
    this.push(t, newMessage('user', [result]));
    return result;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.split('?')[0] !== `/mcp/${this.secret}`) return void res.writeHead(404).end();
    if (req.method === 'GET') return void res.writeHead(405, { allow: 'POST, DELETE' }).end(); // no server-initiated stream
    if (req.method === 'DELETE') return void res.writeHead(200).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      return this.send(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const requests = Array.isArray(body) ? body : [body];
    const replies = (await Promise.all(requests.map((r) => this.dispatch(r)))).filter((r) => r !== undefined);
    if (replies.length === 0) return void res.writeHead(202).end(); // only notifications
    this.send(res, Array.isArray(body) ? replies : replies[0]);
  }

  private send(res: ServerResponse, payload: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  }

  private async dispatch(r: JsonRpcRequest): Promise<unknown> {
    const isNotification = r.id === undefined || r.id === null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: r.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: r.id ?? null, error: { code, message } });
    switch (r.method) {
      case 'initialize': {
        const requested = String(r.params?.protocolVersion ?? '');
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'baton', version: this.version },
          instructions: 'These are the only tools for reading, editing and running things in this project.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: this.tools.specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema })) });
      case 'tools/call': {
        const name = String(r.params?.name ?? '');
        const args = (r.params?.arguments ?? {}) as Record<string, unknown>;
        const result = await this.callTool(name, args);
        return ok({ content: [{ type: 'text', text: result.content }], isError: result.isError === true });
      }
      default:
        if (isNotification) return undefined; // notifications/initialized, cancelled, ...
        return fail(-32601, `Method not found: ${r.method}`);
    }
  }
}
