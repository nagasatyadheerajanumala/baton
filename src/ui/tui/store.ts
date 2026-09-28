import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffLines } from 'diff';
import type { AgentEvents } from '../../agent/loop.js';
import type { ToolCallBlock, ToolResultBlock } from '../../ir/types.js';
import { type Target, targetLabel } from '../../router/router.js';
import { cleanOutput } from './clean.js';
import type { CatalogEntry } from '../../mcp/catalog.js';
import type { McpMenu } from './panels.js';
import { unwrapShell } from '../../tools/readonly.js';

export interface DiffLine {
  sign: '+' | '-';
  line: number | undefined;
  text: string;
}

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; interrupted?: boolean }
  | {
      kind: 'tool';
      callId: string;
      verb: string;
      detail: string;
      status: 'running' | 'ok' | 'error';
      startedAt: number;
      endedAt?: number;
      summary?: string;
      error?: string;
      diff?: DiffLine[];
      added?: number;
      removed?: number;
      procId?: number;
      /** Ran inside the agent CLI's own read-only sandbox (Codex), not through baton. */
      external?: boolean;
      /** Last few lines of output, shown under the call. */
      preview?: string[];
      /** Total output lines, for "+N more". */
      outputLines?: number;
      /** Full (capped) output, for Ctrl+O. */
      output?: string;
    }
  | { kind: 'switch'; fromLabel: string; toLabel: string; toModel: string; reason: string }
  | { kind: 'retry'; label: string; seconds: number; reason: string }
  | { kind: 'compact'; target: string; applied: string[]; tokens: number }
  | { kind: 'notice'; text: string; level: 'info' | 'warn' | 'error' }
  | { kind: 'output'; text: string }
  | { kind: 'command'; text: string };

export interface ApprovalRequest {
  summary: string;
  call?: ToolCallBlock;
  /** "gpt-6-astra · ChatGPT plan": who is asking. */
  asker: string;
  resolve: (ok: boolean) => void;
}

/** Plain-English reason a provider was left, for switch/retry lines. */
export function humanReason(kind: string, isPlan: boolean): string {
  switch (kind) {
    case 'quota':
      return isPlan ? 'hit its usage limit' : 'ran out of credits or quota';
    case 'rate_limit':
      return 'is rate-limited';
    case 'overloaded':
      return 'is overloaded';
    case 'network':
      return "couldn't be reached";
    case 'auth':
      return isPlan ? "isn't signed in" : 'rejected its API key';
    case 'model_not_found':
      return "doesn't offer this model";
    default:
      return 'failed';
  }
}

export type ApprovalMode = 'ask' | 'auto-edit' | 'plan' | 'yolo';

export const MODE_LABELS: Record<ApprovalMode, string> = {
  ask: 'ask before edits and commands',
  'auto-edit': 'auto-approve file edits',
  plan: 'plan mode: look, change nothing',
  yolo: 'full access: never ask',
};

const VERBS: Record<string, string> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  list_files: 'list',
  search: 'search',
  bash: 'bash',
  process_output: 'output',
  process_kill: 'stop',
  process_list: 'procs',
  git_status: 'git',
};

/** mcp__linear__create_issue -> { server: 'linear', tool: 'create_issue' } */
export function mcpParts(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : undefined;
}

export function toolLabel(call: ToolCallBlock): { verb: string; detail: string } {
  const i = call.input;
  const mcp = mcpParts(call.name);
  if (mcp) {
    const args = Object.entries(i).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
    return { verb: `${mcp.server}.${mcp.tool}`, detail: args };
  }
  const verb = VERBS[call.name] ?? call.name;
  switch (call.name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return { verb, detail: String(i.path ?? '') };
    case 'list_files':
      return { verb, detail: String(i.path ?? '.') };
    case 'search':
      return { verb, detail: `/${String(i.pattern ?? '')}/${i.glob ? `  in ${String(i.glob)}` : ''}` };
    case 'bash':
      return { verb, detail: unwrapShell(String(i.command ?? '')) };
    case 'process_output':
    case 'process_kill':
      return { verb, detail: `#${String(i.id ?? '?')}` };
    case 'git_status':
      return { verb, detail: 'status' };
    default:
      return { verb, detail: '' };
  }
}

/** Changed lines of an edit, with line numbers from the file as it was before the edit. */
export function editDiff(cwd: string, input: Record<string, unknown>): { lines: DiffLine[]; added: number; removed: number } {
  const oldStr = String(input.old_string ?? '');
  const newStr = String(input.new_string ?? '');
  let startLine: number | undefined;
  try {
    const before = readFileSync(resolve(cwd, String(input.path ?? '')), 'utf8');
    const at = before.indexOf(oldStr);
    if (at >= 0) startLine = before.slice(0, at).split('\n').length;
  } catch {
    /* file unreadable: show the diff without line numbers */
  }
  const lines: DiffLine[] = [];
  let oldLine = startLine;
  let newLine = startLine;
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldStr, newStr)) {
    const texts = part.value.replace(/\n$/, '').split('\n');
    for (const text of texts) {
      if (part.added) {
        lines.push({ sign: '+', line: newLine, text });
        added++;
        if (newLine !== undefined) newLine++;
      } else if (part.removed) {
        lines.push({ sign: '-', line: oldLine, text });
        removed++;
        if (oldLine !== undefined) oldLine++;
      } else {
        if (oldLine !== undefined) oldLine++;
        if (newLine !== undefined) newLine++;
      }
    }
  }
  return { lines, added, removed };
}

/**
 * All TUI state that isn't keystroke-level. Agent events and process updates
 * mutate it; React re-renders on `change`.
 */
export class TuiStore extends EventEmitter {
  entries: Entry[] = [];
  live = '';
  running = false;
  turnStartedAt = 0;
  approval: ApprovalRequest | null = null;
  approvalMode: ApprovalMode;
  /** Conversation scroll, in lines up from the bottom. */
  scroll = 0;
  pane = { open: false, userClosed: false, focused: false, selectedId: undefined as number | undefined, expanded: false, scroll: 0 };
  /** Messages typed while the agent works; sent in order when the turn ends. */
  queue: string[] = [];
  picker = { open: false, index: 0 };
  mcpPanel: {
    open: boolean;
    cursor: number;
    query: string;
    results: CatalogEntry[];
    searching: boolean;
    error?: string;
    busy?: string;
    menu?: McpMenu;
    imports: CatalogEntry[];
  } = { open: false, cursor: 0, query: '', results: [], searching: false, imports: [] };
  /** Highlighted option in the permission prompt. */
  approvalChoice = 0;
  /** Entries before this index are final and printed to scrollback (inline mode). */
  printed = 0;
  /** Bumped on /clear so the scrollback printer restarts. */
  epoch = 0;
  version = 0;
  /** Set by the app: human labels for chain entries. */
  describe: (t: Target) => { label: string; model: string; plan: boolean } = (t) => ({ label: t.provider, model: t.model, plan: false });
  current: () => Target | undefined = () => undefined;

  constructor(
    readonly cwd: string,
    approvalMode: ApprovalMode = 'ask',
  ) {
    super();
    this.approvalMode = approvalMode;
  }

  changed(): void {
    this.version++;
    this.emit('change');
  }

  push(e: Entry): void {
    this.entries.push(e);
    this.changed();
  }

  clear(): void {
    this.entries = [];
    this.scroll = 0;
    this.printed = 0;
    this.epoch++;
    this.changed();
  }

  /** Entries that can no longer change, in order, stopping at the first live one. */
  finalCount(): number {
    let n = this.printed;
    while (n < this.entries.length && isFinal(this.entries[n]!)) n++;
    return n;
  }

  /** shift+tab: ask → auto-edit → plan → ask. Full access is only entered deliberately (--yes, or "don't ask again" on a command). */
  cycleMode(): ApprovalMode {
    const next: Record<ApprovalMode, ApprovalMode> = { ask: 'auto-edit', 'auto-edit': 'plan', plan: 'ask', yolo: 'ask' };
    this.approvalMode = next[this.approvalMode];
    this.changed();
    return this.approvalMode;
  }

  /** Shown after a plan-mode turn: implement the plan? */
  planPrompt: { choice: number } | null = null;

  enqueue(text: string): void {
    this.queue.push(text);
    this.changed();
  }

  dequeue(): string | undefined {
    const next = this.queue.shift();
    this.changed();
    return next;
  }

  private flushLive(interrupted = false): void {
    if (this.live.trim()) this.entries.push({ kind: 'assistant', text: this.live.trimEnd(), ...(interrupted ? { interrupted } : {}) });
    this.live = '';
  }

  beginTurn(text: string): void {
    this.flushLive();
    this.entries.push({ kind: 'user', text });
    this.running = true;
    this.turnStartedAt = Date.now();
    this.scroll = 0;
    this.changed();
  }

  endTurn(error?: { message: string; level?: 'warn' | 'error' }): void {
    this.flushLive(Boolean(error));
    for (const e of this.entries) {
      if (e.kind === 'tool' && e.status === 'running' && e.procId === undefined) {
        e.status = 'error';
        e.error = 'interrupted';
        e.endedAt = Date.now();
      }
    }
    if (error) this.entries.push({ kind: 'notice', text: error.message, level: error.level ?? 'error' });
    this.running = false;
    this.changed();
  }

  /** Approval gate handed to the agent. */
  approve = (summary: string, call?: ToolCallBlock): Promise<boolean> => {
    if (this.approvalMode === 'yolo') return Promise.resolve(true);
    if (this.approvalMode === 'auto-edit' && !summary.startsWith('$ ')) return Promise.resolve(true);
    const t = this.current();
    const d = t ? this.describe(t) : undefined;
    return new Promise((resolve) => {
      this.approval = { summary, call, asker: d ? `${d.model} · ${d.label}` : 'the model', resolve };
      this.approvalChoice = 0;
      this.changed();
    });
  };

  /**
   * y: allow once. a: allow and stop asking for this session (edits only for
   * file changes, everything for commands). n: deny; the model is told to
   * stop and wait for your instructions.
   */
  answerApproval(answer: 'y' | 'n' | 'a'): void {
    const req = this.approval;
    if (!req) return;
    this.approval = null;
    if (answer === 'a') this.approvalMode = req.summary.startsWith('$ ') ? 'yolo' : this.approvalMode === 'yolo' ? 'yolo' : 'auto-edit';
    req.resolve(answer !== 'n');
    this.changed();
  }

  openPane(open: boolean, byUser = true): void {
    this.pane.open = open;
    if (!open) this.pane.focused = false;
    if (byUser) this.pane.userClosed = !open;
    this.changed();
  }

  events(): AgentEvents {
    return {
      onText: (d) => {
        this.live += d;
        this.changed();
      },
      onToolStart: (call) => {
        this.flushLive();
        const { verb, detail } = toolLabel(call);
        const entry: Extract<Entry, { kind: 'tool' }> = { kind: 'tool', callId: call.id, verb, detail, status: 'running', startedAt: Date.now() };
        if (call.id.startsWith('ext_')) entry.external = true;
        if (call.name === 'edit_file') {
          const d = editDiff(this.cwd, call.input);
          entry.diff = d.lines;
          entry.added = d.added;
          entry.removed = d.removed;
        }
        if (call.name === 'write_file') {
          entry.added = String(call.input.content ?? '').split('\n').length;
          entry.removed = 0;
        }
        this.entries.push(entry);
        this.changed();
      },
      onToolEnd: (call, result) => this.finishTool(call, result),
      onRetry: (target, ms, why) => {
        const d = this.describe(target);
        this.push({ kind: 'retry', label: d.label, seconds: Math.ceil(ms / 1000), reason: humanReason(why.kind, d.plan) });
      },
      onSwitch: (from, to, why) => {
        this.flushLive(true);
        const f = this.describe(from);
        const t = this.describe(to);
        this.push({ kind: 'switch', fromLabel: f.label, toLabel: t.label, toModel: t.model, reason: humanReason(why.kind, f.plan) });
      },
      onCompact: (target, r) => {
        const last = this.entries[this.entries.length - 1];
        // Compaction runs per request; show it once per streak, not on every step.
        if (last?.kind === 'compact' && last.target === targetLabel(target)) return;
        this.push({ kind: 'compact', target: targetLabel(target), applied: r.applied, tokens: r.estTokens });
      },
      onNotice: (m) => this.push({ kind: 'notice', text: m, level: 'warn' }),
    };
  }

  private finishTool(call: ToolCallBlock, result: ToolResultBlock): void {
    const entry = [...this.entries].reverse().find((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool' && e.callId === call.id);
    if (!entry) return;
    entry.endedAt = Date.now();
    entry.status = result.isError ? 'error' : 'ok';
    setPreview(entry, call, result);
    const bg = /background process #(\d+)/.exec(result.content);
    if (call.name === 'bash') {
      if (bg && call.input.background === true && !result.isError) {
        entry.status = 'running'; // still alive; rendered as a live process, not a spinner
        entry.procId = Number(bg[1]);
        entry.summary = `background #${bg[1]}`;
        if (!this.pane.userClosed) this.openPane(true, false);
      } else {
        const exit = /\[(exit \S+|timed out[^\]]*|killed)\]\s*$/.exec(result.content)?.[1];
        const secs = (entry.endedAt - entry.startedAt) / 1000;
        entry.summary = [exit, entry.external ? 'in Codex sandbox' : secs >= 1 ? `${secs.toFixed(1)}s` : ''].filter(Boolean).join(' · ');
      }
    } else if (call.name === 'search') {
      const n = result.content === 'No matches.' ? 0 : result.content.split('\n').filter(Boolean).length;
      entry.summary = `${n} match${n === 1 ? '' : 'es'}`;
    }
    if (result.isError && call.name !== 'bash') entry.error = result.content.split('\n')[0]!.slice(0, 200);
    if (result.isError && call.name === 'bash' && !entry.summary) entry.error = result.content.split('\n')[0]!.slice(0, 200);
    this.changed();
  }
}

/** Final entries never change again, so they can be printed to scrollback. */
export function isFinal(e: Entry): boolean {
  return e.kind !== 'tool' || e.status !== 'running' || e.procId !== undefined;
}

const PREVIEW_LINES = 3;
const OUTPUT_CAP = 20_000;

/** Short preview and full (capped) output of a tool result, for the transcript. */
function setPreview(entry: Extract<Entry, { kind: 'tool' }>, call: ToolCallBlock, result: ToolResultBlock): void {
  if (call.name === 'edit_file' || call.name === 'write_file') return; // the diff/counts say it all
  let text = cleanOutput(result.content).replace(/\n?\[(exit \S+|timed out[^\]]*|killed)\]\s*$/, '');
  if (call.name === 'read_file') {
    const n = text.split('\n').filter((l) => /^\s*\d+\t/.test(l)).length;
    entry.summary = result.isError ? entry.summary : `${n} line${n === 1 ? '' : 's'}`;
    entry.output = text.slice(0, OUTPUT_CAP);
    entry.outputLines = n;
    return;
  }
  if (call.name === 'list_files') {
    const n = text.split('\n').filter(Boolean).length;
    entry.summary = `${n} file${n === 1 ? '' : 's'}`;
  }
  // Background starts: show the process's own output, not baton's instructions to the model.
  if (call.name === 'bash' && call.input.background === true) text = text.includes('Output so far:\n') ? text.split('Output so far:\n')[1]! : '';
  text = text.replace(/^\(no output\)$/, '').trimEnd();
  const lines = text ? text.split('\n') : [];
  entry.outputLines = lines.length;
  entry.preview = lines.filter((l) => l.trim()).slice(0, PREVIEW_LINES);
  entry.output = text.slice(0, OUTPUT_CAP);
}
