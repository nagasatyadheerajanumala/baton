import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexHome } from '../../config/config.js';
import type { AssistantTurn } from '../../ir/types.js';
import type { CompletionRequest, ProviderAdapter } from '../types.js';
import { CliSessions, cliError, runJsonl } from './common.js';
import { buildExternalPrompt } from './transcript.js';

export interface CodexOptions {
  name: string;
  /** Path to the `codex` binary (default: `codex` on PATH). */
  command?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * MCP servers from the user's own Codex config, to switch off for baton's runs:
 * they'd add startup time, noise and tokens, and baton supplies the tools.
 * Reads only config.toml section names, never the auth file.
 */
export function userMcpServers(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const toml = readFileSync(join(codexHome(env), 'config.toml'), 'utf8');
    const names = [...toml.matchAll(/^\s*\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1\]\s*$/gm)].map((m) => m[2]!);
    return [...new Set(names)].filter((n) => n !== 'baton');
  } catch {
    return [];
  }
}

const TOOL_NOTE =
  'Use the tools from the "baton" MCP server for every file edit and every command that changes anything ' +
  '(write_file, edit_file, bash, process_*). Your built-in shell is read-only in this session; use it only to look around.';

/**
 * Uses the official Codex CLI, signed in with the user's ChatGPT plan, as a
 * provider. Codex's sandbox is read-only, so its own shell can only inspect;
 * changes go through baton's tools over MCP (approvals, process pane, log).
 * Its read-only commands are still recorded, so history stays complete.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly name: string;
  readonly external = true;
  readonly label = 'ChatGPT plan';
  private readonly command: string;
  private readonly sessions = new CliSessions();
  private readonly disabledServers: string[];

  constructor(opts: CodexOptions) {
    this.name = opts.name;
    this.command = opts.command ?? 'codex';
    this.disabledServers = userMcpServers(opts.env);
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const bridge = req.bridge;
    if (!bridge) throw new Error('codex provider needs the tool bridge');
    const url = await bridge.start();
    const session = this.sessions.get(req.model);
    const body = buildExternalPrompt(this.sessions.unseen(req.model, req.messages, this.name), !session);
    // Codex has no system-prompt flag; instructions ride along with the first message of a session.
    const prompt = session ? body : `<instructions>\n${req.system}\n\n${TOOL_NOTE}\n</instructions>\n\n${body}`;

    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--model', req.model,
      '-c', 'approval_policy="never"',
      '-c', `mcp_servers.baton.url="${url}"`,
      '-c', 'mcp_servers.baton.tool_timeout_sec=900',
      '-c', 'mcp_servers.baton.startup_timeout_sec=20',
      // baton runs its own approval gate for every tool; Codex shouldn't block baton's server a second time.
      '-c', 'mcp_servers.baton.default_tools_approval_mode="approve"',
      ...this.disabledServers.flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]),
      ...(session ? ['resume', session.id, '-'] : ['-']),
    ];

    let text = '';
    let threadId = session?.id;
    let usage: Record<string, number> | undefined;
    let failure: string | undefined;
    const flushText = () => {
      bridge.recordText(text);
      text = '';
    };

    const run = await runJsonl(this.command, args, {
      cwd: bridge.cwd ?? process.cwd(),
      stdin: prompt,
      signal: req.signal,
      onEvent: (e) => {
        const item = e.item as Record<string, unknown> | undefined;
        switch (e.type) {
          case 'thread.started':
            threadId = String(e.thread_id);
            break;
          case 'item.started':
            if (item?.type === 'mcp_tool_call' || item?.type === 'command_execution') flushText();
            break;
          case 'item.completed':
            if (item?.type === 'agent_message' && typeof item.text === 'string') {
              const t = (text ? '\n\n' : '') + item.text;
              text += t;
              req.onText?.(t);
            } else if (item?.type === 'command_execution') {
              flushText();
              const exit = item.exit_code as number | null | undefined;
              bridge.recordExternal('bash', { command: String(item.command ?? '') }, `${String(item.aggregated_output ?? '').trimEnd()}\n[exit ${exit ?? '?'}]`, (exit ?? 0) !== 0);
            }
            break;
          case 'turn.completed':
            usage = e.usage as Record<string, number>;
            break;
          case 'turn.failed':
            failure = String((e.error as { message?: string })?.message ?? 'turn failed');
            break;
          case 'error':
            failure = String(e.message ?? 'error');
            break;
        }
      },
    });

    if (failure) throw cliError(failure, 'Codex');
    if (!usage) throw cliError(run.stderr.split('\n').filter((l) => l && !l.includes('rmcp::')).slice(-3).join(' '), 'Codex');
    if (threadId) this.sessions.remember(req.model, threadId, [...req.messages.map((m) => m.id), ...bridge.recorded]);

    return {
      content: text ? [{ type: 'text', text }] : [],
      stopReason: 'end_turn',
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
        cachedInputTokens: usage.cached_input_tokens ?? 0,
      },
    };
  }
}
