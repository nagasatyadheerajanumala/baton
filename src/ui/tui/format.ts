import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { type ManagedProcess, type ProcessManager, formatDuration, statusLabel } from '../../tools/processes.js';
import { glyph, t } from '../theme.js';
import type { Entry } from './store.js';
import { cleanOutput } from './clean.js';

export { cleanOutput };

const MAX_DIFF_LINES = 8;

export const width = (s: string) => stringWidth(s);

/** Truncate an ANSI string to `w` columns, adding an ellipsis. */
export function truncate(s: string, w: number): string {
  if (width(s) <= w) return s;
  if (w <= 1) return '…'.slice(0, w);
  return wrapAnsi(s, w - 1, { hard: true, trim: false, wordWrap: false }).split('\n')[0] + '…';
}

export function padRight(s: string, w: number): string {
  const n = w - width(s);
  return n > 0 ? s + ' '.repeat(n) : truncate(s, w);
}

/** Left and right content on one line of exactly `w` columns; the left side truncates first. */
export function justify(left: string, right: string, w: number): string {
  const rw = width(right);
  const lw = Math.max(0, w - rw - 2);
  const l = truncate(left, lw);
  return l + ' '.repeat(Math.max(1, w - width(l) - rw)) + right;
}

export function wrap(s: string, w: number): string[] {
  return wrapAnsi(s, Math.max(1, w), { hard: true, trim: false }).split('\n');
}

// ---- Conversation ------------------------------------------------------------------

export interface ConversationContext {
  width: number;
  now: number;
  spinner: string;
  processes: ProcessManager;
  /** Tool call currently waiting for the user's approval. */
  waitingCallId?: string;
}

const TOOL_NAMES: Record<string, string> = {
  read: 'Read', write: 'Write', edit: 'Edit', list: 'List', search: 'Search', bash: 'Shell',
  output: 'Output', stop: 'Stop', procs: 'Processes', git: 'Git',
};

export function welcomeLines(w: number, version: string): string[] {
  return [
    '',
    `  ${t.bold('baton')} ${t.muted(`v${version}`)}`,
    ...gutter('  ', '  ', t.muted('Ask for a change, a fix, or an explanation. If a model hits its limit, baton hands the session to the next one and keeps going.'), w),
    '',
    t.muted(`  / commands  ${glyph.sep}  shift+tab permission mode  ${glyph.sep}  ^O full output  ${glyph.sep}  ^P processes  ${glyph.sep}  esc interrupt`),
    '',
  ];
}

/** Indent continuation lines under a gutter so wrapped text lines up. */
function gutter(first: string, rest: string, text: string, w: number): string[] {
  const lines = wrap(text, Math.max(10, w - width(first)));
  return lines.map((l, i) => (i === 0 ? first : rest) + l);
}

export function renderEntry(e: Entry, ctx: ConversationContext): string[] {
  const w = ctx.width;
  switch (e.kind) {
    case 'user':
      return [...gutter(`${t.accent(glyph.prompt)} `, '  ', t.bold(e.text), w), ''];
    case 'assistant': {
      const body = e.text.split('\n').flatMap((para, i) => gutter(i === 0 ? `${t.text(glyph.active)} ` : '  ', '  ', para, w));
      return e.interrupted ? [...body, `  ${t.muted('(cut off: the provider switched mid-answer)')}`, ''] : [...body, ''];
    }
    case 'tool':
      return renderTool(e, ctx);
    case 'switch':
      return [
        t.warning(t.bold(`↪ Switched to ${e.toLabel}`)) + t.warning(` (${e.toModel})`),
        ...gutter('  ', '  ', t.muted(`${e.fromLabel} ${e.reason}. The conversation and your files carried over.`), w),
        '',
      ];
    case 'retry':
      return [`  ${t.warning(glyph.wait)} ${t.muted(`${e.label} ${e.reason}, retrying in ${e.seconds}s`)}`];
    case 'compact':
      return [`  ${t.muted(`${glyph.sep} trimmed older history to fit ${e.target} (≈${e.tokens.toLocaleString()} tokens)`)}`];
    case 'notice': {
      const color = e.level === 'error' ? t.danger : e.level === 'warn' ? t.warning : t.muted;
      return ['', ...gutter('  ', '  ', color(e.text), w), ''];
    }
    case 'output':
      return [...e.text.split('\n').flatMap((l) => gutter('  ', '  ', l, w)), ''];
    case 'command':
      return ['', t.muted(`${glyph.prompt} ${e.text}`)];
  }
}

function renderTool(e: Extract<Entry, { kind: 'tool' }>, ctx: ConversationContext): string[] {
  const w = ctx.width;
  const proc = e.procId !== undefined ? ctx.processes.get(e.procId) : undefined;
  const waiting = ctx.waitingCallId === e.callId && e.status === 'running';
  let mark: string;
  let summary = e.summary ?? '';
  if (waiting) {
    mark = t.warning('?');
    summary = 'waiting for your approval';
  } else if (proc) {
    mark = proc.running ? t.accent(glyph.active) : proc.info.exitCode === 0 ? t.success(glyph.ok) : t.muted(glyph.idle);
    summary = proc.running ? `running in background #${proc.info.id} (^P)` : `#${proc.info.id} ${statusLabel(proc.info)}`;
  } else if (e.status === 'running') mark = t.accent(ctx.spinner);
  else mark = e.status === 'ok' ? t.success(glyph.active) : t.danger(glyph.active);

  const name = TOOL_NAMES[e.verb] ?? e.verb;
  const counts = e.added !== undefined ? ` ${t.success(`+${e.added}`)} ${t.danger(`-${e.removed ?? 0}`)}` : '';
  const tail = `${counts}${summary ? `  ${waiting ? t.warning(summary) : t.muted(summary)}` : ''}`;
  const detail = e.detail.replace(/\s*\n\s*/g, ' ');
  const room = Math.max(8, w - width(`x ${name}()`) - width(tail) - 1);
  const head = `${mark} ${t.bold(name)}${detail ? t.muted('(') + truncate(detail, room) + t.muted(')') : ''}${tail}`;
  const lines = [truncate(head, w)];
  const bar = t.muted('  ⎿  ');
  const pad = '     ';

  if (e.diff?.length) {
    const numWidth = Math.max(2, ...e.diff.map((d) => String(d.line ?? '').length));
    e.diff.slice(0, MAX_DIFF_LINES).forEach((d, i) => {
      const color = d.sign === '+' ? t.success : t.danger;
      lines.push(truncate(`${i === 0 ? bar : pad}${t.muted(String(d.line ?? '').padStart(numWidth))} ${color(`${d.sign} ${d.text}`)}`, w));
    });
    if (e.diff.length > MAX_DIFF_LINES) lines.push(`${pad}${t.muted(`… +${e.diff.length - MAX_DIFF_LINES} more changed lines`)}`);
  } else if (e.preview?.length) {
    e.preview.forEach((l, i) => lines.push(truncate(`${i === 0 ? bar : pad}${t.muted(l)}`, w)));
    const more = (e.outputLines ?? 0) - e.preview.length;
    if (more > 0) lines.push(`${pad}${t.muted(`… +${more} line${more === 1 ? '' : 's'} (ctrl+o to expand)`)}`);
  }
  if (e.error) lines.push(...gutter(e.diff?.length || e.preview?.length ? pad : bar, pad, t.danger(e.error), w));
  return lines;
}

export function renderConversation(entries: Entry[], live: string, ctx: ConversationContext, version: string): string[] {
  if (entries.length === 0 && !live) return welcomeLines(ctx.width, version);
  const lines = entries.flatMap((e) => renderEntry(e, ctx));
  if (live) lines.push(...live.split('\n').flatMap((para, i) => gutter(i === 0 ? `${glyph.active} ` : '  ', '  ', para, ctx.width)));
  while (lines.length && lines[0] === '') lines.shift();
  return lines;
}

// ---- Process pane ----------------------------------------------------------------

export interface PaneLayout {
  lines: string[];
  /** Pane-relative row index -> process id, for mouse selection. */
  rowIds: Map<number, number>;
  /** Column range (pane-relative) of the close control on row 0. */
  closeCols: [number, number];
}

function procMark(p: ManagedProcess, spinner: string): string {
  if (p.running) return t.accent(p.info.background ? glyph.active : spinner);
  if (p.info.status === 'exited') return p.info.exitCode === 0 ? t.success(glyph.ok) : t.danger(glyph.fail);
  return t.muted(glyph.idle);
}

export function renderPane(
  procs: ProcessManager,
  opts: { width: number; height: number; selectedId?: number; expanded: boolean; focused: boolean; scroll: number; now: number; spinner: string },
): PaneLayout {
  const w = opts.width;
  const list = procs.list();
  const running = procs.runningCount;
  const rowIds = new Map<number, number>();
  const close = 'esc ✕';
  const title = ` ${t.bold('Processes')}  ${t.muted(running ? `${running} running` : 'none running')}`;
  const lines = [justify(title, t.muted(close), w)];
  const closeCols: [number, number] = [w - width(close), w];

  if (list.length === 0) {
    lines.push('', t.muted(' Commands the agent runs'), t.muted(' show up here, with live'), t.muted(' output.'));
    return { lines: fill(lines, opts.height, w), rowIds, closeCols };
  }

  const selected = list.find((p) => p.info.id === opts.selectedId) ?? list[0]!;
  const maxRows = opts.expanded ? 1 : Math.max(1, Math.min(list.length, Math.floor(opts.height / 3)));
  // Keep the selection visible when the list is longer than the space.
  const selIdx = list.indexOf(selected);
  const start = opts.expanded ? selIdx : Math.min(Math.max(0, selIdx - maxRows + 1), Math.max(0, list.length - maxRows));
  for (const p of list.slice(start, start + maxRows)) {
    const age = formatDuration((p.info.endedAt ?? opts.now) - p.info.startedAt);
    const right = p.running ? age : t.muted(statusLabel(p.info));
    const row = justify(` ${procMark(p, opts.spinner)} ${t.muted(`#${p.info.id}`.padEnd(3))} ${p.info.command}`, `${right} `, w);
    rowIds.set(lines.length, p.info.id);
    lines.push(p === selected ? t.selected(padRight(row, w)) : row);
  }
  if (!opts.expanded && list.length > maxRows) lines.push(t.muted(` + ${list.length - maxRows} more  ↑↓`));

  lines.push(t.rule('─'.repeat(w)));
  const keys = opts.focused ? `↑↓ ${glyph.sep} ↵ ${opts.expanded ? 'collapse' : 'expand'}${selected.running ? ` ${glyph.sep} k stop` : ''} ${glyph.sep} c clear` : 'tab to select';
  const facts = selected.running
    ? `pid ${selected.info.pid ?? '?'}`
    : `${statusLabel(selected.info)} ${glyph.sep} ${formatDuration((selected.info.endedAt ?? opts.now) - selected.info.startedAt)}`;
  const meta = `#${selected.info.id} ${glyph.sep} ${facts} ${glyph.sep} ${keys}`;
  lines.push(t.muted(truncate(` ${meta}`, w)));

  const outRows = Math.max(0, opts.height - lines.length);
  const out = cleanOutput(selected.output).replace(/\n$/, '');
  const wrapped = out ? out.split('\n').flatMap((l) => wrap(l, w - 1)).map((l) => ` ${l}`) : [t.muted(' (no output yet)')];
  const maxScroll = Math.max(0, wrapped.length - outRows);
  const scroll = Math.min(opts.scroll, maxScroll);
  lines.push(...wrapped.slice(Math.max(0, wrapped.length - outRows - scroll), wrapped.length - scroll));
  if (scroll > 0 && lines.length) lines[lines.length - 1] = t.muted(padRight(` ↓ ${scroll} more lines`, w));
  return { lines: fill(lines, opts.height, w), rowIds, closeCols };
}

function fill(lines: string[], height: number, w: number): string[] {
  const out = lines.slice(0, height).map((l) => padRight(l, w));
  while (out.length < height) out.push(' '.repeat(w));
  return out;
}

// ---- Chrome ------------------------------------------------------------------------

export interface ChainItem {
  model: string;
  state: 'active' | 'ready' | 'cooldown' | 'disabled' | 'no-key';
}

export function renderHeader(cwdLabel: string, chain: ChainItem[], w: number): string {
  const items = chain.map((c) => {
    const short = c.model.replace(/^claude-/, 'claude-').replace(/:.*$/, '');
    switch (c.state) {
      case 'active':
        return `${short} ${t.success(glyph.active)}`;
      case 'cooldown':
        return `${t.muted(short)} ${t.warning(glyph.idle)}`;
      case 'disabled':
      case 'no-key':
        return `${t.muted(short)} ${t.danger(glyph.fail)}`;
      default:
        return t.muted(`${short} ${glyph.idle}`);
    }
  });
  let right = items.join(` ${t.muted(glyph.chain)} `);
  // On narrow screens, show only the active model.
  if (width(right) > w * 0.6) right = items[chain.findIndex((c) => c.state === 'active')] ?? '';
  return justify(` ${t.bold('baton')}  ${t.muted(cwdLabel)}`, `${right} `, w);
}

export interface StatusInfo {
  model: string;
  contextPct: number;
  tokens: number;
  usd: number;
  partialCost: boolean;
  switches: number;
  running: number;
  busy: boolean;
  paneFocused: boolean;
  /** Current model runs on a subscription plan (Claude Code / Codex). */
  plan?: boolean;
}

export interface StatusLayout {
  line: string;
  /** Column range of the "⚙ N running" control, for mouse. */
  procCols: [number, number];
}

export function renderStatus(s: StatusInfo, w: number): StatusLayout {
  const tok = s.tokens >= 1000 ? `${(s.tokens / 1000).toFixed(1)}k` : String(s.tokens);
  const dollars = `≈$${s.usd.toFixed(2)}${s.partialCost ? '+' : ''}`;
  const parts = [`ctx ${s.contextPct}%`, `${tok} tok`, s.plan ? (s.usd > 0 ? `${dollars} + plan` : 'plan') : dollars];
  if (s.switches) parts.push(`${s.switches} switch${s.switches === 1 ? '' : 'es'}`);
  const left = ` ${t.success(glyph.active)} ${s.model}  ${t.muted(parts.join(` ${glyph.sep} `))}`;

  const procs = `${glyph.gear} ${s.running} running`;
  const procLabel = s.running ? t.accent(procs) : t.muted(procs);
  const hints = s.paneFocused ? t.muted('tab back') : t.muted(`^P  ${s.busy ? '^C interrupt' : '^D exit'}`);
  const right = `${procLabel} ${hints} `;
  const line = justify(left, right, w);
  const start = w - width(right);
  return { line, procCols: [start, start + width(procs)] };
}

export function renderInput(
  value: string,
  cursor: number,
  opts: { width: number; busy: boolean; spinner: string; elapsed: string; approval?: string; hint?: string },
): string {
  const w = opts.width;
  if (opts.approval) {
    return justify(` ${t.warning('Allow')}  ${t.bold(opts.approval)} ${t.muted('?')}`, `${t.bold('1')} ${t.muted('yes')}   ${t.bold('2')} ${t.muted('yes, always')}   ${t.bold('3')} ${t.muted('no')} `, w);
  }
  if (opts.busy) return justify(` ${t.accent(opts.spinner)} ${t.muted(`working ${glyph.sep} ${opts.elapsed}`)}`, `${t.muted('^C interrupt')} `, w);
  const prompt = ` ${t.accent(glyph.prompt)} `;
  const right = opts.hint ?? t.muted('/ commands');
  // justify() reserves width(right) + 1 trailing space + 2 gap columns.
  const room = Math.max(1, w - width(prompt) - width(right) - 3);
  if (!value) return justify(`${prompt}${t.inverse(' ')}${t.muted('Ask baton to…')}`, `${right} `, w);
  // Scroll the visible window so the cursor stays on screen.
  const start = Math.max(0, cursor - room + 1);
  const visible = value.slice(start, start + room);
  const at = cursor - start;
  const text = visible.slice(0, at) + t.inverse(visible[at] ?? ' ') + visible.slice(at + 1);
  return justify(`${prompt}${text}`, `${right} `, w);
}
