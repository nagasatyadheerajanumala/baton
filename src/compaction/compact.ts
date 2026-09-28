import { callIndex, isHumanTurnStart, newMessage, settleMessages, touchedFiles } from '../ir/session.js';
import { type ContentBlock, type Message, isText, isToolCall, isToolResult } from '../ir/types.js';

/**
 * Deterministic context compaction.
 *
 * Compaction produces a *view* of the history sized to a target model's
 * budget; the session log itself is never rewritten. Passes run cheapest
 * fidelity loss first and stop as soon as the view fits:
 *
 *   1. stale-reads   read_file output superseded by a later read/write of that path
 *   2. truncate      old tool output cut to head+tail
 *   3. drop-turns    oldest turns replaced by a synthetic state summary
 *                    (the original task, i.e. the first human turn, is always kept)
 *
 * LLM summarization can slot in later as a pass between 2 and 3.
 */

export interface CompactOptions {
  budgetTokens: number;
  /** Recent human turns never touched by passes 1-2. */
  keepRecentTurns?: number;
  /** Max chars for an old tool result after truncation. */
  toolOutputCap?: number;
}

export interface CompactResult {
  messages: Message[];
  estTokens: number;
  /** Which passes ran, for /status and debug output. */
  applied: string[];
}

const CHARS_PER_TOKEN = 3.5; // conservative for code-heavy text
const PER_BLOCK_OVERHEAD = 8;

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  let blocks = 0;
  for (const m of messages) {
    for (const b of m.content) {
      blocks++;
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'tool_call') chars += b.name.length + JSON.stringify(b.input).length;
      else if (b.type === 'tool_result') chars += b.content.length;
      else chars += JSON.stringify(b.data).length / 4; // mostly signature; vendors bill only what they keep
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + blocks * PER_BLOCK_OVERHEAD;
}

export const estimateTextTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

export function compact(history: Message[], opts: CompactOptions): CompactResult {
  const keepRecent = opts.keepRecentTurns ?? 4;
  const cap = opts.toolOutputCap ?? 4_000;
  const applied: string[] = [];
  let messages = history;

  const fits = () => estimateTokens(messages) <= opts.budgetTokens;
  if (fits()) return { messages, estTokens: estimateTokens(messages), applied };

  const recentStart = () => turnStartIndex(messages, keepRecent);

  messages = collapseStaleReads(messages, recentStart());
  applied.push('stale-reads');
  if (fits()) return done();

  messages = truncateOldResults(messages, recentStart(), cap);
  applied.push('truncate');
  if (fits()) return done();

  for (let k = keepRecent; k >= 1; k--) {
    const protectFrom = turnStartIndex(history, k);
    const trimmed = truncateOldResults(collapseStaleReads(history, protectFrom), protectFrom, cap);
    messages = dropMiddleTurns(trimmed, history, k);
    if (fits()) break;
  }
  applied.push('drop-turns');
  if (fits()) return done();

  // Last resort: the in-progress turn itself is huge (long tool loop). Trim
  // everything but the newest message, then everything, harder.
  messages = truncateOldResults(messages, messages.length - 1, cap);
  if (!fits()) messages = truncateOldResults(messages, messages.length, Math.min(cap, 1_000));
  applied.push('truncate-current');
  return done();

  function done(): CompactResult {
    messages = repairPairing(messages);
    return { messages, estTokens: estimateTokens(messages), applied };
  }
}

// ---- Turn helpers ------------------------------------------------------------

/** Split history into turns, each beginning at a human-typed user message. */
export function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of messages) {
    if (isHumanTurnStart(m) || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

/** Index of the first message in the last `k` turns. */
function turnStartIndex(messages: Message[], k: number): number {
  const turns = splitTurns(messages);
  const kept = turns.slice(Math.max(0, turns.length - k));
  return messages.length - kept.reduce((n, t) => n + t.length, 0);
}

// ---- Pass 1: stale reads -----------------------------------------------------------

function collapseStaleReads(messages: Message[], protectFrom: number): Message[] {
  const calls = callIndex(messages);
  // For each path, the position of its most recent read/write/edit call.
  const lastTouch = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const b of m.content) {
      if (isToolCall(b) && ['read_file', 'write_file', 'edit_file'].includes(b.name) && typeof b.input.path === 'string') {
        lastTouch.set(b.input.path, i);
      }
    }
  });

  return messages.map((m, i) => {
    if (i >= protectFrom || m.role !== 'user') return m;
    let changed = false;
    const content = m.content.map((b): ContentBlock => {
      if (!isToolResult(b)) return b;
      const call = calls.get(b.callId);
      const path = call?.input.path;
      if (call?.name !== 'read_file' || typeof path !== 'string') return b;
      if ((lastTouch.get(path) ?? -1) <= i - 1) return b; // this was the latest touch
      changed = true;
      return { ...b, content: `[compacted: stale contents of ${path}; the file was re-read or modified later]` };
    });
    return changed ? { ...m, content } : m;
  });
}

// ---- Pass 2: truncate old tool output ----------------------------------------

function truncateOldResults(messages: Message[], protectFrom: number, cap: number): Message[] {
  return messages.map((m, i) => {
    if (i >= protectFrom || m.role !== 'user') return m;
    let changed = false;
    const content = m.content.map((b): ContentBlock => {
      if (!isToolResult(b) || b.content.length <= cap) return b;
      changed = true;
      return { ...b, content: headTail(b.content, cap) };
    });
    return changed ? { ...m, content } : m;
  });
}

export function headTail(s: string, cap: number): string {
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n[... ${omitted} chars compacted ...]\n\n${s.slice(-tail)}`;
}

// ---- Pass 3: drop middle turns ---------------------------------------------------

function dropMiddleTurns(messages: Message[], fullHistory: Message[], keepRecent: number): Message[] {
  const turns = splitTurns(messages);
  if (turns.length <= keepRecent + 1) return messages;
  const first = turns[0]!;
  const dropped = turns.slice(1, turns.length - keepRecent).flat();
  const recent = turns.slice(turns.length - keepRecent).flat();
  const summary = newMessage('user', [{ type: 'text', text: stateSummary(dropped, fullHistory) }], { synthetic: true });
  return [...first, summary, ...recent];
}

function stateSummary(dropped: Message[], fullHistory: Message[]): string {
  const requests = dropped
    .filter(isHumanTurnStart)
    .map((m) => m.content.filter(isText).map((b) => b.text).join(' ').replace(/\s+/g, ' ').slice(0, 240));
  const commands = dropped
    .flatMap((m) => m.content.filter(isToolCall))
    .filter((c) => c.name === 'bash' && typeof c.input.command === 'string')
    .map((c) => String(c.input.command).slice(0, 160))
    .slice(-15);
  const files = touchedFiles(fullHistory);

  const lines = ['[baton: earlier conversation compacted to fit the context window]'];
  if (requests.length) lines.push('', 'Earlier user requests (oldest first):', ...requests.map((r) => `- ${r}`));
  if (files.length) lines.push('', 'Files modified this session:', ...files.map((f) => `- ${f}`));
  if (commands.length) lines.push('', 'Recent shell commands from the compacted span:', ...commands.map((c) => `- ${c}`));
  lines.push('', 'Re-read any file before editing it; do not rely on memory of compacted contents.');
  return lines.join('\n');
}

// ---- Pairing repair --------------------------------------------------------------------

/**
 * After dropping turns, a tool_result may have lost its call (or vice versa).
 * Drop orphan results, then let settle() answer any dangling calls.
 */
export function repairPairing(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user') {
      const prev = out[out.length - 1];
      const validIds = new Set(prev?.role === 'assistant' ? prev.content.filter(isToolCall).map((c) => c.id) : []);
      const content = m.content.filter((b) => !isToolResult(b) || validIds.has(b.callId));
      if (content.length === 0) continue;
      out.push(content.length === m.content.length ? m : { ...m, content });
    } else {
      out.push(m);
    }
  }
  return settleMessages(out).messages;
}
