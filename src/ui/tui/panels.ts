import type { ToolCallBlock } from '../../ir/types.js';
import type { ProcessManager } from '../../tools/processes.js';
import { formatDuration } from '../../tools/processes.js';
import { unwrapShell } from '../../tools/readonly.js';
import { glyph, t } from '../theme.js';
import { justify, padRight, renderPane, truncate, width, wrap } from './format.js';
import { type ApprovalMode, MODE_LABELS, editDiff } from './store.js';

/**
 * Bottom-of-screen widgets for the inline UI. Each returns exact-width lines.
 * Styling follows one rule: a rounded box in the accent (or warning, for
 * decisions) color, a title on the top border, content inside.
 */

type Paint = (s: string) => string;

export function box(title: string, right: string, body: string[], w: number, paint: Paint = t.rule): string[] {
  const inner = w - 4;
  const titleText = title ? ` ${title} ` : '';
  const rightText = right ? ` ${right} ` : '';
  const fill = Math.max(0, w - 3 - width(titleText) - width(rightText) - 1);
  const top = paint('╭─') + titleText + paint('─'.repeat(fill)) + rightText + paint('─╮');
  const rows = body.map((l) => `${paint('│')} ${padRight(l, inner)} ${paint('│')}`);
  return [truncate(top, w), ...rows, paint(`╰${'─'.repeat(w - 2)}╯`)];
}

// ---- Shell display --------------------------------------------------------------

/** Lay a shell script out one command per line, indenting loop and if bodies. */
export function prettyShell(command: string): string[] {
  const src = unwrapShell(command).trim();
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '\n') {
      parts.push(cur.trim());
      cur = '';
    } else if (ch === '&' && src[i + 1] === '&') {
      parts.push(cur.trim());
      cur = '&& ';
      i++;
    } else cur += ch;
  }
  parts.push(cur.trim());
  const out: string[] = [];
  let depth = 0;
  for (const p of parts.filter(Boolean).map((x) => x.replace(/^&&\s+/, '&& '))) {
    const opener = /^(do|then|else)\b\s*/.exec(p);
    if (opener) {
      // "for x in a; do" / "if cond; then" read best on one line.
      if (opener[1] === 'else') depth = Math.max(0, depth - 1);
      if (out.length && opener[1] !== 'else') out[out.length - 1] += `; ${opener[1]}`;
      else out.push('  '.repeat(depth) + opener[1]);
      depth++;
      const rest = p.slice(opener[0].length);
      if (rest) out.push('  '.repeat(depth) + rest);
      continue;
    }
    if (/^(done|fi|esac)\b/.test(p)) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + p);
  }
  return out;
}

// ---- Permission prompt ------------------------------------------------------------

export interface ApprovalView {
  summary: string;
  call?: ToolCallBlock;
  asker: string;
  choice: number;
  cwd: string;
  /** Shortened cwd for display (~/...). */
  cwdLabel?: string;
  mode: ApprovalMode;
}

export function approvalOptions(summary: string): string[] {
  const isCommand = summary.startsWith('$ ');
  return [
    'Yes',
    isCommand ? "Yes, and don't ask again for commands this session" : 'Yes, and auto-approve file edits this session',
    'No, and tell it what to do instead',
  ];
}

export function renderApproval(v: ApprovalView, w: number): string[] {
  const inner = w - 4;
  const call = v.call;
  let title = `Allow ${v.summary}?`;
  const body: string[] = [''];
  const MAX = 12;
  const push = (lines: string[]) => {
    for (const l of lines.slice(0, MAX)) body.push(...wrap(l, inner - 2).map((x) => `  ${x}`));
    if (lines.length > MAX) body.push(t.muted(`  … ${lines.length - MAX} more lines`));
  };

  if (call?.name === 'bash') {
    title = call.input.background === true ? 'Start a background process?' : 'Run a shell command?';
    push(prettyShell(String(call.input.command ?? '')).map((l) => t.bold(l)));
    body.push(t.muted(`  in ${v.cwdLabel ?? v.cwd}`));
  } else if (call?.name === 'edit_file') {
    const d = editDiff(v.cwd, call.input);
    title = `Edit ${String(call.input.path)}?`;
    push(d.lines.map((l) => (l.sign === '+' ? t.success : t.danger)(`${l.sign} ${l.text}`)));
  } else if (call?.name === 'write_file') {
    const content = String(call.input.content ?? '');
    const n = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    title = `Write ${String(call.input.path)} (${n} line${n === 1 ? '' : 's'})?`;
    push(content.split('\n').slice(0, 8).map((l) => t.muted(l)));
  } else {
    body.push(`  ${v.summary}`);
  }

  body.push('');
  approvalOptions(v.summary).forEach((label, i) => {
    const sel = i === v.choice;
    const text = `${i + 1}. ${label}`;
    body.push(sel ? `${t.warning('❯')} ${t.bold(text)}` : `  ${t.muted(text)}`);
  });
  body.push('');
  body.push(t.muted(`↑↓ + enter, or press 1 · 2 · 3   ${glyph.sep}   esc = no`));
  return box(t.warning(t.bold(title)), t.muted(v.asker), body, w, t.warning);
}

// ---- Model picker ----------------------------------------------------------------

export interface PickerAccount {
  targetIndex: number;
  label: string;
  /** The model this account uses now. */
  model: string;
  current: boolean;
  state: 'active' | 'ready' | 'cooldown' | 'disabled' | 'no-key';
  cooldownMs: number;
  models: { id: string; description: string }[];
}

export interface PickerItem {
  targetIndex: number;
  model: string;
}

/** Selectable rows, in display order. */
export function pickerItems(accounts: PickerAccount[]): PickerItem[] {
  return accounts.flatMap((a) => a.models.map((m) => ({ targetIndex: a.targetIndex, model: m.id })));
}

export function accountStatus(a: Pick<PickerAccount, 'state' | 'cooldownMs'>, now: number): string {
  switch (a.state) {
    case 'active':
      return t.success('in use');
    case 'ready':
      return t.muted('ready');
    case 'cooldown': {
      const at = new Date(now + a.cooldownMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return t.warning(`limit reached · back after ${at}`);
    }
    case 'no-key':
      return t.danger('no API key (run baton doctor)');
    default:
      return t.danger('unavailable (run baton doctor)');
  }
}

export function renderModelPicker(accounts: PickerAccount[], cursor: number, w: number, now: number): string[] {
  const items = pickerItems(accounts);
  const selected = items[cursor];
  const idw = Math.max(8, ...accounts.flatMap((a) => a.models.map((m) => m.id.length))) + 2;
  const body: string[] = [];
  accounts.forEach((a, ai) => {
    if (ai > 0) body.push('');
    body.push(`${t.bold(a.label)}  ${accountStatus(a, now)}${t.muted(`  · failover #${ai + 1}`)}`);
    for (const m of a.models) {
      const isSel = selected?.targetIndex === a.targetIndex && selected.model === m.id;
      const isUsed = m.id === a.model;
      const dot = isUsed && a.current ? t.success(glyph.active) : isUsed ? t.text(glyph.idle) : ' ';
      const tag = isUsed ? (a.current ? t.success('  in use') : t.muted('  default')) : '';
      const line = `${dot} ${isSel ? t.bold(m.id.padEnd(idw)) : m.id.padEnd(idw)}${t.muted(m.description)}${tag}`;
      body.push(`${isSel ? t.accent('❯') : ' '} ${line}`);
    }
  });
  body.push('', t.muted(`↑↓ choose ${glyph.sep} enter switch (saved as that account's default) ${glyph.sep} esc cancel ${glyph.sep} the conversation carries over`));
  return box(t.bold('Switch model'), t.muted('accounts in failover order'), body, w, t.accent);
}

// ---- Processes panel -------------------------------------------------------------

export function renderProcBox(procs: ProcessManager, opts: { width: number; height: number; selectedId?: number; now: number; spinner: string }): string[] {
  const inner = opts.width - 4;
  const pane = renderPane(procs, { width: inner, height: Math.max(4, opts.height - 2), selectedId: opts.selectedId, expanded: false, focused: true, scroll: 0, now: opts.now, spinner: opts.spinner });
  // renderPane's first row is its own title; the box border carries the title here.
  const running = procs.runningCount;
  const lines = pane.lines.slice(1).map((l) => l.replace(` ${glyph.sep} ↵ expand`, ''));
  return box(t.bold('Processes'), t.muted(`${running ? `${running} running` : 'none running'} · esc close`), lines, opts.width, t.accent);
}

// ---- Input box ---------------------------------------------------------------------

/** Wrapping prompt editor with a visible cursor. */
export function renderInputBox(value: string, cursor: number, opts: { width: number; placeholder: string; busy: boolean }): string[] {
  const inner = opts.width - 4;
  const promptGlyph = opts.busy ? t.muted(glyph.prompt) : t.accent(glyph.prompt);
  if (!value) return box('', '', [`${promptGlyph} ${t.inverse(' ')}${t.muted(opts.placeholder)}`], opts.width);
  const room = inner - 2;
  const lines: string[] = [];
  for (let i = 0; i <= value.length; i += room) {
    const chunk = value.slice(i, i + room);
    const at = cursor - i;
    const withCursor = at >= 0 && at < room ? chunk.slice(0, at) + t.inverse(chunk[at] ?? ' ') + chunk.slice(at + 1) : chunk;
    lines.push(`${i === 0 ? promptGlyph : ' '} ${withCursor}`);
    if (lines.length >= 6) break;
  }
  return box('', '', lines, opts.width);
}

// ---- Status lines ------------------------------------------------------------------

export function renderWorking(opts: { spinner: string; elapsedMs: number; width: number; queued: number }): string {
  const q = opts.queued ? ` ${glyph.sep} ${opts.queued} message${opts.queued === 1 ? '' : 's'} queued` : '';
  return truncate(`${t.accent(opts.spinner)} ${t.text('Working…')} ${t.muted(`${formatDuration(opts.elapsedMs)} ${glyph.sep} esc to interrupt ${glyph.sep} type to queue a follow-up${q}`)}`, opts.width);
}

export function renderQueue(queue: string[], w: number): string[] {
  return queue.map((q) => truncate(`${t.muted('  ↳ queued:')} ${q}`, w));
}

export interface FooterInfo {
  model: string;
  label: string;
  contextLeftPct: number;
  plan: boolean;
  usd: number;
  mode: ApprovalMode;
  running: number;
  switches: number;
}

export function renderFooter(f: FooterInfo, w: number): string {
  const spend = f.plan ? 'on your plan' : `$${f.usd.toFixed(2)} so far`;
  const parts = [`${f.contextLeftPct}% context left`, spend];
  if (f.switches) parts.push(`${f.switches} switch${f.switches === 1 ? '' : 'es'}`);
  const left = ` ${t.success(glyph.active)} ${f.model} ${t.muted(`· ${f.label} · ${parts.join(' · ')}`)}`;
  const modeColor = f.mode === 'yolo' ? t.danger : f.mode === 'auto-edit' ? t.warning : t.muted;
  const mode = modeColor(`⏵ ${MODE_LABELS[f.mode]}`) + t.muted(' (shift+tab)');
  const procs = f.running ? `  ${t.accent(`${glyph.gear} ${f.running} running`)}${t.muted(' (^P)')}` : '';
  const right = `${mode}${procs} `;
  if (width(left) + width(right) + 2 > w) {
    return justify(left, `${modeColor(`⏵ ${f.mode === 'ask' ? 'ask' : f.mode === 'auto-edit' ? 'auto-edit' : 'full access'}`)}${procs} `, w);
  }
  return justify(left, right, w);
}
