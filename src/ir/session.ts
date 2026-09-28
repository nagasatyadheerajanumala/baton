import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ContentBlock,
  type Message,
  type MessageMeta,
  type Role,
  type ToolCallBlock,
  isText,
  isToolCall,
  isToolResult,
} from './types.js';

/** A provider switch, recorded for /status and for the handoff note. */
export interface SwitchEvent {
  from: string;
  to: string;
  reason: string;
  ts: number;
}

type LogLine =
  | { kind: 'header'; id: string; cwd: string; ts: number }
  | { kind: 'message'; message: Message }
  | { kind: 'switch'; event: SwitchEvent };

export const sessionsDir = () => join(process.env.BATON_HOME ?? join(homedir(), '.baton'), 'sessions');

export function newMessage(role: Role, content: ContentBlock[], meta: Partial<MessageMeta> = {}): Message {
  return { id: randomUUID(), role, content, meta: { ts: Date.now(), ...meta } };
}

/**
 * Append-only session. The in-memory `messages` array is the source of truth;
 * the JSONL file is a write-ahead log so a crashed or rate-limited process can
 * be resumed with `baton --resume <id>`.
 */
export class Session {
  readonly messages: Message[] = [];
  readonly switches: SwitchEvent[] = [];
  private file: string | undefined;

  constructor(
    readonly id: string = randomUUID(),
    readonly cwd: string = process.cwd(),
    opts: { persist?: boolean } = {},
  ) {
    if (opts.persist ?? true) {
      mkdirSync(sessionsDir(), { recursive: true });
      this.file = join(sessionsDir(), `${id}.jsonl`);
      if (!existsSync(this.file)) this.write({ kind: 'header', id, cwd, ts: Date.now() });
    }
  }

  static load(id: string): Session {
    const file = join(sessionsDir(), `${id}.jsonl`);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const header = JSON.parse(lines[0] ?? '{}') as LogLine;
    if (header.kind !== 'header') throw new Error(`Corrupt session file: ${file}`);
    const s = new Session(id, header.cwd, { persist: false });
    for (const raw of lines.slice(1)) {
      const line = JSON.parse(raw) as LogLine;
      if (line.kind === 'message') s.messages.push(line.message);
      if (line.kind === 'switch') s.switches.push(line.event);
    }
    // Re-attach persistence without rewriting the header.
    s.file = file;
    s.settle();
    return s;
  }

  /** Most recently modified session id, for `--continue`. */
  static latestId(): string | undefined {
    if (!existsSync(sessionsDir())) return undefined;
    const files = readdirSync(sessionsDir())
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(join(sessionsDir(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files[0]?.f.replace(/\.jsonl$/, '');
  }

  push(message: Message): Message {
    this.messages.push(message);
    this.write({ kind: 'message', message });
    return message;
  }

  recordSwitch(event: SwitchEvent): void {
    this.switches.push(event);
    this.write({ kind: 'switch', event });
  }

  /**
   * Repair any dangling tool calls so the history is valid for *every*
   * provider. Anthropic rejects a `tool_use` without a matching `tool_result`;
   * OpenAI rejects an assistant `tool_calls` entry without a `tool` message.
   *
   * This only triggers after a crash mid-tool-execution (or a hand-edited log);
   * the agent loop never commits partial turns in normal operation.
   * Returns the number of synthetic results inserted.
   */
  settle(): number {
    const repaired = settleMessages(this.messages);
    if (repaired.inserted > 0) {
      this.messages.splice(0, this.messages.length, ...repaired.messages);
      // Persist the synthetic results so a resumed log stays consistent.
      for (const m of repaired.messages.filter((m) => m.meta.synthetic)) this.write({ kind: 'message', message: m });
    }
    return repaired.inserted;
  }

  private write(line: LogLine): void {
    if (this.file) appendFileSync(this.file, JSON.stringify(line) + '\n');
  }
}

export const INTERRUPTED_RESULT =
  'Tool call was interrupted before it completed (session crashed or provider switched). ' +
  'Its effects are unknown; re-check state before relying on it.';

/** Pure version of Session.settle, exported for tests and compaction. */
export function settleMessages(original: Message[]): { messages: Message[]; inserted: number } {
  const input = [...original];
  const out: Message[] = [];
  let inserted = 0;

  for (let i = 0; i < input.length; i++) {
    const msg = input[i]!;
    out.push(msg);
    if (msg.role !== 'assistant') continue;

    const calls = msg.content.filter(isToolCall);
    if (calls.length === 0) continue;

    const next = input[i + 1];
    const answered = new Set(
      next?.role === 'user' ? next.content.filter(isToolResult).map((r) => r.callId) : [],
    );
    const missing = calls.filter((c) => !answered.has(c.id));
    if (missing.length === 0) continue;

    const synthetic: ContentBlock[] = missing.map((c) => ({
      type: 'tool_result',
      callId: c.id,
      content: INTERRUPTED_RESULT,
      isError: true,
    }));
    inserted += missing.length;

    if (next?.role === 'user') {
      // Merge into the existing user message: results must come first.
      input[i + 1] = { ...next, content: [...synthetic, ...next.content] };
    } else {
      out.push(newMessage('user', synthetic, { synthetic: true }));
    }
  }
  return { messages: out, inserted };
}

// ---- Derived views over history (never stored, always recomputed) ----------

/** Files the agent created or modified this session, in first-touch order. */
export function touchedFiles(messages: Message[]): string[] {
  const seen = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (isToolCall(b) && (b.name === 'write_file' || b.name === 'edit_file')) {
        const p = b.input.path;
        if (typeof p === 'string') seen.add(p);
      }
    }
  }
  return [...seen];
}

/** Index tool calls by id, for looking up what a tool_result was answering. */
export function callIndex(messages: Message[]): Map<string, ToolCallBlock> {
  const idx = new Map<string, ToolCallBlock>();
  for (const m of messages) for (const b of m.content) if (isToolCall(b)) idx.set(b.id, b);
  return idx;
}

/** A user message containing typed text (as opposed to only tool results). */
export const isHumanTurnStart = (m: Message) => m.role === 'user' && m.content.some(isText);
