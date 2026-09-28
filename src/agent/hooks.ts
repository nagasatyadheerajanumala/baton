import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolCallBlock, ToolResultBlock } from '../ir/types.js';
import { projectRoot } from './instructions.js';

/**
 * Hooks in Claude Code's format, so the ones people already wrote work here:
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "..." }] }] } }
 * Read from ~/.claude/settings.json and baton's config (always), and from a
 * project's .claude/settings(.local).json only once that folder is trusted,
 * because a cloned repo could otherwise run commands on the user's machine.
 */

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'SessionEnd';
export const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'];

export interface HookCommand {
  type: 'command';
  command: string;
  /** Seconds (default 60). */
  timeout?: number;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>;

export interface HookSource {
  path: string;
  label: string;
  project: boolean;
  hooks: HooksConfig;
}

export interface HookOutcome {
  /** Set when a hook blocks the action; the text explains why. */
  block?: string;
  /** PreToolUse: a hook explicitly allowed the call (skip the permission prompt). */
  allow?: boolean;
  /** Extra context hooks want the model to see. */
  context: string[];
}

// ---- Loading ---------------------------------------------------------------------------

function readHooks(path: string): HooksConfig | undefined {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: HooksConfig };
    return d.hooks && Object.keys(d.hooks).length ? d.hooks : undefined;
  } catch {
    return undefined;
  }
}

export function loadHookSources(cwd: string, batonHooks?: HooksConfig): HookSource[] {
  const out: HookSource[] = [];
  const user = readHooks(join(homedir(), '.claude', 'settings.json'));
  if (user) out.push({ path: join(homedir(), '.claude', 'settings.json'), label: '~/.claude/settings.json', project: false, hooks: user });
  if (batonHooks && Object.keys(batonHooks).length) out.push({ path: 'baton config', label: 'baton config', project: false, hooks: batonHooks });
  const root = projectRoot(cwd);
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    const h = readHooks(join(root, f));
    if (h) out.push({ path: join(root, f), label: f, project: true, hooks: h });
  }
  return out;
}

const trustFile = (env: NodeJS.ProcessEnv = process.env) => join(env.BATON_HOME ?? join(homedir(), '.baton'), 'trusted.json');

export function isTrusted(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return (JSON.parse(readFileSync(trustFile(env), 'utf8')) as string[]).includes(projectRoot(cwd));
  } catch {
    return false;
  }
}

export function setTrusted(cwd: string, trusted: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const file = trustFile(env);
  let list: string[] = [];
  try {
    list = JSON.parse(readFileSync(file, 'utf8')) as string[];
  } catch {
    /* none yet */
  }
  const root = projectRoot(cwd);
  const next = trusted ? [...new Set([...list, root])] : list.filter((p) => p !== root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}

// ---- Tool naming -------------------------------------------------------------------------

/** baton tool -> Claude Code tool name and input shape, so matchers like "Edit|Write" just work. */
export function claudeToolView(call: ToolCallBlock): { name: string; input: Record<string, unknown> } {
  const i = call.input;
  switch (call.name) {
    case 'bash':
      return { name: 'Bash', input: { command: i.command, run_in_background: i.background === true, timeout: i.timeout_ms } };
    case 'read_file':
      return { name: 'Read', input: { file_path: i.path, offset: i.offset, limit: i.limit } };
    case 'write_file':
      return { name: 'Write', input: { file_path: i.path, content: i.content } };
    case 'edit_file':
      return { name: 'Edit', input: { file_path: i.path, old_string: i.old_string, new_string: i.new_string, replace_all: i.replace_all === true } };
    case 'search':
      return { name: 'Grep', input: { pattern: i.pattern, path: i.path, glob: i.glob } };
    case 'list_files':
      return { name: 'Glob', input: { path: i.path } };
    case 'skill':
      return { name: 'Skill', input: { skill: i.name } };
    case 'process_output':
      return { name: 'BashOutput', input: { bash_id: i.id } };
    case 'process_kill':
      return { name: 'KillShell', input: { shell_id: i.id } };
    default:
      return { name: call.name, input: i }; // mcp__server__tool is already Claude's naming
  }
}

// ---- Running -------------------------------------------------------------------------------

function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*' || toolName === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function runOne(cmd: HookCommand, payload: Record<string, unknown>, cwd: string, root: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd.command], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: root, BATON_PROJECT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), (cmd.timeout ?? 60) * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Runs the configured hooks for an event and folds their answers together
 * using Claude Code's conventions: exit 2 blocks (stderr is the reason);
 * exit 0 may print JSON (decision / permissionDecision / additionalContext /
 * continue); plain stdout from prompt and session hooks becomes context.
 * Emits `notice` for hook failures that don't block anything.
 */
export class HookRunner extends EventEmitter {
  private readonly root: string;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: string,
    private readonly transcriptPath: string,
    private readonly sources: HookSource[],
    private trusted: boolean,
  ) {
    super();
    this.root = projectRoot(cwd);
  }

  get isTrusted(): boolean {
    return this.trusted;
  }

  /** /trust: let this project's own hooks run (remembered in ~/.baton/trusted.json). */
  setTrusted(value: boolean): void {
    this.trusted = value;
    setTrusted(this.cwd, value);
  }

  get allSources(): HookSource[] {
    return this.sources;
  }

  /** Sources that actually run (project hooks only when trusted). */
  get active(): HookSource[] {
    return this.sources.filter((s) => !s.project || this.trusted);
  }

  get untrustedProjectHooks(): HookSource[] {
    return this.trusted ? [] : this.sources.filter((s) => s.project);
  }

  private commands(event: HookEvent, toolName?: string): HookCommand[] {
    return this.active.flatMap((s) => (s.hooks[event] ?? []).filter((g) => matches(g.matcher, toolName)).flatMap((g) => g.hooks.filter((h) => h.type === 'command' && h.command)));
  }

  async run(event: HookEvent, extra: Record<string, unknown> = {}, toolName?: string): Promise<HookOutcome> {
    const outcome: HookOutcome = { context: [] };
    const cmds = this.commands(event, toolName);
    if (!cmds.length) return outcome;
    const payload = { session_id: this.sessionId, transcript_path: this.transcriptPath, cwd: this.cwd, hook_event_name: event, ...extra };
    const results = await Promise.all(cmds.map((c) => runOne(c, payload, this.cwd, this.root).then((r) => ({ c, r }))));
    for (const { c, r } of results) {
      if (r.code === 2) {
        outcome.block = [outcome.block, r.stderr.trim() || `blocked by hook: ${c.command}`].filter(Boolean).join('\n');
        continue;
      }
      if (r.code !== 0) {
        this.emit('notice', `Hook failed (${event}, exit ${r.code}): ${c.command}${r.stderr.trim() ? ` — ${r.stderr.trim().split('\n')[0]}` : ''}`);
        continue;
      }
      const out = r.stdout.trim();
      let json: Record<string, unknown> | undefined;
      if (out.startsWith('{')) {
        try {
          json = JSON.parse(out) as Record<string, unknown>;
        } catch {
          /* plain text */
        }
      }
      if (!json) {
        if (out && (event === 'UserPromptSubmit' || event === 'SessionStart')) outcome.context.push(out);
        continue;
      }
      const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
      const decision = String(specific.permissionDecision ?? json.decision ?? '');
      const reason = String(specific.permissionDecisionReason ?? json.reason ?? json.stopReason ?? '');
      if (json.continue === false || decision === 'block' || decision === 'deny') outcome.block = [outcome.block, reason || `blocked by hook: ${c.command}`].filter(Boolean).join('\n');
      else if (decision === 'allow' || decision === 'approve') outcome.allow = true;
      if (typeof specific.additionalContext === 'string' && specific.additionalContext) outcome.context.push(specific.additionalContext);
    }
    if (outcome.block) outcome.allow = false;
    return outcome;
  }

  preToolUse(call: ToolCallBlock): Promise<HookOutcome> {
    const v = claudeToolView(call);
    return this.run('PreToolUse', { tool_name: v.name, tool_input: v.input }, v.name);
  }

  postToolUse(call: ToolCallBlock, result: ToolResultBlock): Promise<HookOutcome> {
    const v = claudeToolView(call);
    return this.run('PostToolUse', { tool_name: v.name, tool_input: v.input, tool_response: { content: result.content, is_error: result.isError === true } }, v.name);
  }

  get hasAny(): boolean {
    return this.active.some((s) => HOOK_EVENTS.some((e) => (s.hooks[e] ?? []).length));
  }
}

export function transcriptPathFor(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const p = join(env.BATON_HOME ?? join(homedir(), '.baton'), 'sessions', `${sessionId}.jsonl`);
  return existsSync(p) ? p : '';
}
