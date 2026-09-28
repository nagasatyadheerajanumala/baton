import type { AssistantTurn } from '../../ir/types.js';
import type { CompletionRequest, ProviderAdapter } from '../types.js';
import { CliSessions, cliError, runJsonl } from './common.js';
import { buildExternalPrompt } from './transcript.js';

export interface ClaudeCodeOptions {
  name: string;
  /** Path to the `claude` binary (default: `claude` on PATH). */
  command?: string;
}

/**
 * Uses the official, unmodified Claude Code CLI, signed in with the user's
 * own Claude subscription, as a provider. baton never sees the login: the CLI
 * handles auth itself, which is what Anthropic's terms permit.
 *
 * Claude Code's built-in tools are switched off (`--tools ""`); it gets
 * baton's tools over MCP instead, so approvals, the process pane and the
 * session log keep working, and a later switch away sees every step.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly name: string;
  readonly external = true;
  private readonly command: string;
  private readonly sessions = new CliSessions();

  constructor(opts: ClaudeCodeOptions) {
    this.name = opts.name;
    this.command = opts.command ?? 'claude';
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const bridge = req.bridge;
    if (!bridge) throw new Error('claude-code provider needs the tool bridge');
    const url = await bridge.start();
    const session = this.sessions.get(req.model);
    const prompt = buildExternalPrompt(this.sessions.unseen(req.model, req.messages, this.name), !session);

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', JSON.stringify({ mcpServers: { baton: { type: 'http', url } } }),
      '--allowedTools', 'mcp__baton',
      '--model', req.model,
      '--system-prompt', req.system,
      ...(session ? ['--resume', session.id] : []),
    ];

    let text = '';
    let sawDelta = false;
    let sessionId = session?.id;
    let result: Record<string, unknown> | undefined;
    const flushText = () => {
      bridge.recordText(text);
      text = '';
    };

    const run = await runJsonl(this.command, args, {
      cwd: bridge.cwd ?? process.cwd(),
      stdin: prompt,
      signal: req.signal,
      // Long approvals and slow commands must not trip the MCP client timeout.
      env: { MCP_TOOL_TIMEOUT: '900000', MCP_TIMEOUT: '20000' },
      onEvent: (e) => {
        if (e.type === 'system' && e.subtype === 'init') {
          sessionId = String(e.session_id);
          const servers = (e.mcp_servers ?? []) as Array<{ name: string; status: string }>;
          const baton = servers.find((s) => s.name === 'baton');
          if (baton && baton.status !== 'connected') throw new Error(`Claude Code could not connect to baton's tools (${baton.status})`);
        } else if (e.type === 'stream_event') {
          const ev = e.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            sawDelta = true;
            text += ev.delta.text;
            req.onText?.(ev.delta.text);
          }
        } else if (e.type === 'assistant') {
          const content = ((e.message as { content?: unknown[] })?.content ?? []) as Array<{ type: string; text?: string }>;
          if (!sawDelta) {
            const t = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
            if (t) {
              text += t;
              req.onText?.(t);
            }
          }
          sawDelta = false;
          // Prose before a tool call is a step of its own; the tool call is recorded by the bridge.
          if (content.some((b) => b.type === 'tool_use')) flushText();
        } else if (e.type === 'result') {
          result = e;
        }
      },
    });

    if (!result) throw cliError(run.stderr.split('\n').filter(Boolean).slice(-3).join(' '), 'Claude Code');
    if (result.is_error) throw cliError(String(result.result ?? result.subtype ?? ''), 'Claude Code');
    if (sessionId) this.sessions.remember(req.model, sessionId, [...req.messages.map((m) => m.id), ...bridge.recorded]);

    const u = (result.usage ?? {}) as Record<string, number>;
    return {
      content: text || result.result ? [{ type: 'text', text: text || String(result.result) }] : [],
      stopReason: 'end_turn',
      usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
      },
    };
  }
}
