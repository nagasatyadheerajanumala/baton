import type { ToolCallBlock } from '../../ir/types.js';
import type { CatalogEntry } from '../../mcp/catalog.js';
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
  } else if (call && /^mcp__/.test(call.name)) {
    const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(call.name) ?? [];
    title = `Use ${server} · ${tool}?`;
    const json = JSON.stringify(call.input, null, 2).split('\n');
    push(json.length > 1 ? json.slice(1, -1).map((l) => l.replace(/^ {2}/, '')) : ['(no arguments)']);
    body.push(t.muted(`  MCP server "${server}"`));
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
  const modeColor = f.mode === 'yolo' ? t.danger : f.mode === 'auto-edit' ? t.warning : f.mode === 'plan' ? t.accent : t.muted;
  const mode = modeColor(`⏵ ${MODE_LABELS[f.mode]}`) + t.muted(' (shift+tab)');
  const procs = f.running ? `  ${t.accent(`${glyph.gear} ${f.running} running`)}${t.muted(' (^P)')}` : '';
  const right = `${mode}${procs} `;
  if (width(left) + width(right) + 2 > w) {
    const short = { ask: 'ask', 'auto-edit': 'auto-edit', plan: 'plan mode', yolo: 'full access' }[f.mode];
    return justify(left, `${modeColor(`⏵ ${short}`)}${procs} `, w);
  }
  return justify(left, right, w);
}

// ---- MCP panel ------------------------------------------------------------------------

export type McpRow =
  | { kind: 'server'; name: string; status: 'connecting' | 'connected' | 'needs-login' | 'failed' | 'disabled'; error?: string; tools: number; where: string }
  | { kind: 'candidate'; entry: CatalogEntry };

export interface McpSection {
  title: string;
  rows: McpRow[];
  /** Shown when the section has no rows. */
  empty?: string;
}

export interface McpMenu {
  server: string;
  options: string[];
  index: number;
  /** Tool names, when "View tools" is open. */
  tools?: string[];
}

export interface McpPanelView {
  query: string;
  searching: boolean;
  searchError?: string;
  sections: McpSection[];
  cursor: number;
  busy?: string;
  menu?: McpMenu;
}

/** Selectable rows in display order. */
export function mcpRows(sections: McpSection[]): McpRow[] {
  return sections.flatMap((s) => s.rows);
}

export function serverMenuOptions(status: string): string[] {
  switch (status) {
    case 'connected':
      return ['View tools', 'Reconnect', 'Disable', 'Remove'];
    case 'needs-login':
      return ['Sign in', 'Disable', 'Remove'];
    case 'disabled':
      return ['Enable', 'Remove'];
    case 'connecting':
      return ['Remove'];
    default:
      return ['Retry', 'Disable', 'Remove'];
  }
}

function serverStatus(r: Extract<McpRow, { kind: 'server' }>): string {
  switch (r.status) {
    case 'connected':
      return t.success(`connected · ${r.tools} tool${r.tools === 1 ? '' : 's'}`);
    case 'connecting':
      return t.muted('connecting…');
    case 'needs-login':
      return t.warning('needs sign-in · enter to sign in');
    case 'disabled':
      return t.muted('disabled');
    default:
      return t.danger(`failed: ${r.error ?? ''}`);
  }
}

export function renderMcpPanel(v: McpPanelView, w: number, maxBody: number): string[] {
  const inner = w - 4;
  const head: string[] = [];
  head.push(`${t.accent('⌕')} ${v.query ? t.bold(v.query) : t.muted('Type to search the MCP registry…')}${t.inverse(' ')}${v.searching ? t.muted('  searching…') : ''}`);
  if (v.searchError) head.push(t.danger(`  registry search failed: ${v.searchError}`));
  if (v.busy) head.push(t.warning(`  ${v.busy}`));
  head.push('');

  let body: string[] = [];
  let cursorLine = 0;
  if (v.menu) {
    const m = v.menu;
    body.push(t.bold(m.server));
    if (m.tools) {
      body.push(...(m.tools.length ? m.tools.map((tool) => `  ${t.muted('·')} ${tool}`) : [t.muted('  (no tools)')]));
      body.push('', t.muted('esc back'));
    } else {
      m.options.forEach((o, i) => body.push(`${i === m.index ? t.accent('❯') : ' '} ${i === m.index ? t.bold(o) : o}`));
      body.push('', t.muted(`↑↓ choose ${glyph.sep} enter ${glyph.sep} esc back`));
      cursorLine = 1 + m.index;
    }
  } else {
    let n = 0;
    const idw = Math.min(22, Math.max(10, ...mcpRows(v.sections).map((r) => (r.kind === 'server' ? r.name : r.entry.name).length)) + 2);
    for (const s of v.sections) {
      if (!s.rows.length && !s.empty) continue;
      if (body.length) body.push('');
      body.push(t.muted(s.title));
      if (!s.rows.length) body.push(t.muted(`  ${s.empty}`));
      for (const r of s.rows) {
        const sel = n === v.cursor;
        if (sel) cursorLine = body.length;
        const pointer = sel ? t.accent('❯') : ' ';
        if (r.kind === 'server') {
          const dot = r.status === 'connected' ? t.success(glyph.active) : r.status === 'failed' ? t.danger(glyph.active) : r.status === 'disabled' ? t.muted(glyph.idle) : t.warning(glyph.active);
          body.push(truncate(`${pointer} ${dot} ${sel ? t.bold(r.name.padEnd(idw)) : r.name.padEnd(idw)}${serverStatus(r)}${r.where ? t.muted(`  · ${r.where}`) : ''}`, inner));
        } else {
          const e = r.entry;
          const kind = e.config.url ? 'remote' : 'local';
          const tags = [e.origin === 'popular' || e.origin === 'registry' ? '' : e.origin, kind, e.needsEnv?.length ? `needs ${e.needsEnv.join(', ')}` : '', e.builtIn ? 'Codex built-in' : ''].filter(Boolean).join(' · ');
          body.push(truncate(`${pointer} ${t.accent('+')} ${sel ? t.bold(e.name.padEnd(idw)) : e.name.padEnd(idw)}${t.muted(`${e.description}${e.description ? '  ' : ''}(${tags})`)}`, inner));
        }
        n++;
      }
    }
    body.push('', t.muted(`↑↓ move ${glyph.sep} enter add / manage ${glyph.sep} type to search ${glyph.sep} esc ${v.query ? 'clear search' : 'close'}`));
  }

  // Keep the selected row visible when the list is taller than the space.
  const room = Math.max(6, maxBody - head.length);
  if (body.length > room) {
    const start = Math.min(Math.max(0, cursorLine - Math.floor(room / 2)), body.length - room);
    const footer = body[body.length - 1]!;
    body = body.slice(start, start + room - 1);
    body.push(footer);
  }
  return box(t.bold('MCP servers'), t.muted('tools work with every model in your chain'), [...head, ...body], w, t.accent);
}

// ---- Plan approval -------------------------------------------------------------------

export const PLAN_OPTIONS = ['Yes, and auto-approve file edits', 'Yes, but ask before each change', 'No, keep planning'];

export function renderPlanPrompt(choice: number, w: number): string[] {
  const body = ['', ...PLAN_OPTIONS.map((o, i) => (i === choice ? `${t.accent('❯')} ${t.bold(`${i + 1}. ${o}`)}` : `  ${t.muted(`${i + 1}. ${o}`)}`)), '', t.muted(`↑↓ + enter, or press 1 · 2 · 3   ${glyph.sep}   esc = keep planning`)];
  return box(t.accent(t.bold('Ready to implement this plan?')), t.muted('plan mode'), body, w, t.accent);
}

// ---- Rewind picker -------------------------------------------------------------------

export function renderRewind(items: { label: string; ts: number }[], index: number, loading: boolean, w: number, now: number, ago: (ts: number, now: number) => string): string[] {
  const body: string[] = [];
  if (loading) body.push(t.muted('loading snapshots…'));
  else if (!items.length) body.push(t.muted('No snapshots yet. baton takes one before each request.'));
  items.forEach((it, i) => {
    const sel = i === index;
    const when = ago(it.ts, now).padEnd(11);
    const label = it.label === 'before rewind' ? t.muted('before a rewind (undo that rewind)') : `before “${it.label}”`;
    body.push(truncate(`${sel ? t.accent('❯') : ' '} ${t.muted(when)} ${sel ? t.bold(label) : label}`, w - 4));
  });
  body.push('', t.muted(`↑↓ choose ${glyph.sep} enter restore files to that point ${glyph.sep} esc cancel`));
  return box(t.bold('Rewind files'), t.muted('snapshots taken before each request'), body, w, t.accent);
}

// ---- @file suggestions -----------------------------------------------------------------

export function renderMentions(items: string[], index: number, w: number, loading: boolean): string[] {
  if (loading) return [t.muted('  finding files…')];
  if (!items.length) return [t.muted('  no matching files')];
  return [
    ...items.map((p, i) => truncate(`  ${i === index ? t.accent('❯') : ' '} ${i === index ? t.bold(p) : p}`, w)),
    t.muted(`    tab/enter insert ${glyph.sep} esc dismiss`),
  ];
}

// ---- Slash command menu ----------------------------------------------------------------

export interface SlashItem {
  name: string;
  description: string;
  kind: 'built-in' | 'command' | 'skill';
  /** Shown after the name, e.g. "[focus]". */
  hint?: string;
  /** Needs arguments typed after it before running. */
  takesArgs?: boolean;
}

export const BUILTIN_COMMANDS: SlashItem[] = [
  { name: 'model', description: 'switch model or account', kind: 'built-in' },
  { name: 'mcp', description: 'MCP servers: status, sign in, add more', kind: 'built-in' },
  { name: 'init', description: 'write or improve AGENTS.md for this project', kind: 'built-in' },
  { name: 'memory', description: 'instruction files every model follows', kind: 'built-in' },
  { name: 'skills', description: 'skills every model can use', kind: 'built-in' },
  { name: 'hooks', description: 'hooks that run automatically', kind: 'built-in' },
  { name: 'trust', description: "let this project's own hooks run", kind: 'built-in' },
  { name: 'undo', description: "undo the last request's file changes", kind: 'built-in' },
  { name: 'rewind', description: 'restore files from an earlier point', kind: 'built-in' },
  { name: 'status', description: 'session, usage and switches', kind: 'built-in' },
  { name: 'compact', description: 'preview history compaction', kind: 'built-in' },
  { name: 'clear', description: 'clear the screen', kind: 'built-in' },
  { name: 'help', description: 'all commands and keys', kind: 'built-in' },
  { name: 'exit', description: 'quit (session is saved)', kind: 'built-in' },
];

/** Matching commands: name prefix first, then name contains, then description contains. */
export function matchSlash(items: SlashItem[], query: string, limit = 50): SlashItem[] {
  const q = query.toLowerCase();
  const rank = (i: SlashItem) => (i.name.toLowerCase().startsWith(q) ? 0 : i.name.toLowerCase().includes(q) ? 1 : i.description.toLowerCase().includes(q) ? 2 : 3);
  return items
    .map((i) => ({ i, r: rank(i) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || (a.i.kind === 'built-in' ? 0 : 1) - (b.i.kind === 'built-in' ? 0 : 1) || a.i.name.localeCompare(b.i.name))
    .slice(0, limit)
    .map((x) => x.i);
}

export function renderSlashMenu(items: SlashItem[], index: number, w: number, visible = 8): string[] {
  if (!items.length) return [t.muted('  no matching command')];
  const start = Math.min(Math.max(0, index - visible + 1), Math.max(0, items.length - visible));
  const shown = items.slice(start, start + visible);
  const nw = Math.min(28, Math.max(...shown.map((i) => i.name.length + (i.hint ? i.hint.length + 1 : 0))) + 3);
  const lines = shown.map((it, k) => {
    const sel = start + k === index;
    const label = `/${it.name}${it.hint ? ` ${it.hint}` : ''}`;
    const tag = it.kind === 'built-in' ? '' : t.muted(`  ${it.kind}`);
    return truncate(`  ${sel ? t.accent('❯') : ' '} ${sel ? t.bold(label.padEnd(nw)) : label.padEnd(nw)}${t.muted(it.description)}${tag}`, w);
  });
  const more = items.length > visible ? ` ${glyph.sep} ${index + 1}/${items.length}` : '';
  lines.push(t.muted(`    ↑↓ choose ${glyph.sep} tab complete ${glyph.sep} enter run${more}`));
  return lines;
}
