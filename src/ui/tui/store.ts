import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffLines } from 'diff';
import type { AgentEvents } from '../../agent/loop.js';
import type { ToolCallBlock, ToolResultBlock } from '../../ir/types.js';
import { targetLabel } from '../../router/router.js';

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
    }
  | { kind: 'switch'; to: string; reason: string }
  | { kind: 'retry'; target: string; seconds: number; reason: string }
  | { kind: 'compact'; target: string; applied: string[]; tokens: number }
  | { kind: 'notice'; text: string; level: 'info' | 'warn' | 'error' }
  | { kind: 'output'; text: string }
  | { kind: 'command'; text: string };

export interface ApprovalRequest {
  summary: string;
  resolve: (ok: boolean) => void;
}

export type ApprovalMode = 'ask' | 'auto-edit' | 'yolo';

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

export function toolLabel(call: ToolCallBlock): { verb: string; detail: string } {
  const i = call.input;
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
      return { verb, detail: String(i.command ?? '') };
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
  version = 0;

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
    this.changed();
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
  approve = (summary: string): Promise<boolean> => {
    if (this.approvalMode === 'yolo') return Promise.resolve(true);
    if (this.approvalMode === 'auto-edit' && !summary.startsWith('$ ')) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.approval = { summary, resolve };
      this.changed();
    });
  };

  answerApproval(answer: 'y' | 'n' | 'a'): void {
    const req = this.approval;
    if (!req) return;
    this.approval = null;
    if (answer === 'a') this.approvalMode = 'yolo';
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
        this.push({ kind: 'retry', target: targetLabel(target), seconds: Math.ceil(ms / 1000), reason: why.kind });
      },
      onSwitch: (from, to, why) => {
        this.flushLive(true);
        this.push({ kind: 'switch', to: targetLabel(to), reason: `${from.provider} ${why.kind.replace('_', ' ')}` });
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
    const bg = /background process #(\d+)/.exec(result.content);
    if (call.name === 'bash') {
      if (bg && call.input.background === true && !result.isError) {
        entry.status = 'running'; // still alive; rendered as a live process, not a spinner
        entry.procId = Number(bg[1]);
        entry.summary = `background #${bg[1]}`;
        if (!this.pane.userClosed) this.openPane(true, false);
      } else {
        const exit = /\[(exit \d+|timed out[^\]]*|killed)\]\s*$/.exec(result.content)?.[1];
        entry.summary = [exit, `${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)}s`].filter(Boolean).join(' · ');
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
