import { describe, expect, it } from 'vitest';
import { compact, estimateTokens, splitTurns } from '../src/compaction/compact.js';
import { INTERRUPTED_RESULT, settleMessages } from '../src/ir/session.js';
import { type Message, isToolCall, isToolResult } from '../src/ir/types.js';

let n = 0;
const m = (role: Message['role'], content: Message['content']): Message => ({ id: String(n++), role, content, meta: { ts: 0 } });
const big = (label: string, kb: number) => `${label}\n${'x'.repeat(kb * 1024)}`;

/** A turn where the agent reads `path` (big output) and runs a command. */
function turn(i: number, path: string, kb = 20): Message[] {
  return [
    m('user', [{ type: 'text', text: `request ${i}` }]),
    m('assistant', [{ type: 'tool_call', id: `r${i}`, name: 'read_file', input: { path } }]),
    m('user', [{ type: 'tool_result', callId: `r${i}`, content: big(`contents of ${path} @${i}`, kb) }]),
    m('assistant', [{ type: 'tool_call', id: `b${i}`, name: 'bash', input: { command: `npm test -- ${i}` } }]),
    m('user', [{ type: 'tool_result', callId: `b${i}`, content: big(`test output ${i}`, kb) }]),
    m('assistant', [{ type: 'text', text: `finished ${i}` }]),
  ];
}

function assertPaired(messages: Message[]) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    const calls = msg.content.filter(isToolCall).map((c) => c.id);
    if (!calls.length) continue;
    const results = messages[i + 1]?.content.filter(isToolResult).map((r) => r.callId) ?? [];
    expect(results.sort()).toEqual(calls.sort());
  }
  // and no orphan results
  const allCalls = new Set(messages.flatMap((x) => x.content.filter(isToolCall).map((c) => c.id)));
  for (const r of messages.flatMap((x) => x.content.filter(isToolResult))) expect(allCalls.has(r.callId)).toBe(true);
}

describe('compact', () => {
  const history = Array.from({ length: 10 }, (_, i) => turn(i, i % 2 ? 'src/a.ts' : 'src/b.ts')).flat();

  it('is the identity when under budget', () => {
    const r = compact(history, { budgetTokens: 10_000_000 });
    expect(r.messages).toBe(history);
    expect(r.applied).toEqual([]);
  });

  it('collapses stale reads and truncates old output before dropping anything', () => {
    const r = compact(history, { budgetTokens: 60_000 });
    expect(r.estTokens).toBeLessThanOrEqual(60_000);
    expect(r.messages).toHaveLength(history.length); // nothing dropped
    const flat = r.messages.flatMap((x) => x.content.filter(isToolResult)).map((x) => x.content);
    expect(flat.some((c) => c.includes('stale contents of src/a.ts'))).toBe(true);
    expect(r.applied).not.toContain('drop-turns');
    assertPaired(r.messages);
  });

  it('drops middle turns under pressure but keeps the original task and a state summary', () => {
    const r = compact(history, { budgetTokens: 8_000 });
    expect(r.estTokens).toBeLessThanOrEqual(8_000);
    expect(r.applied).toContain('drop-turns');
    const texts = r.messages.flatMap((x) => x.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    expect(texts[0]).toBe('request 0'); // original task survives
    const summary = texts.find((t) => t.includes('earlier conversation compacted'))!;
    expect(summary).toContain('request 3');
    expect(summary).toContain('npm test -- 3');
    expect(texts).toContain('request 9'); // most recent turn survives
    assertPaired(r.messages);
  });

  it('never mutates the input history', () => {
    const snapshot = JSON.stringify(history);
    compact(history, { budgetTokens: 5_000 });
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('shrinks a single enormous in-progress turn', () => {
    const one = turn(0, 'huge.log', 400);
    expect(estimateTokens(one)).toBeGreaterThan(200_000);
    const r = compact(one, { budgetTokens: 4_000 });
    expect(r.estTokens).toBeLessThanOrEqual(4_000);
    expect(r.applied).toContain('truncate-current');
    assertPaired(r.messages);
  });

  it('splits turns at human-typed messages only', () => {
    expect(splitTurns(history)).toHaveLength(10);
  });
});

describe('settleMessages', () => {
  it('answers dangling tool calls with a synthetic interrupted result', () => {
    const msgs = [
      m('user', [{ type: 'text', text: 'go' }]),
      m('assistant', [
        { type: 'tool_call', id: 'a', name: 'bash', input: {} },
        { type: 'tool_call', id: 'b', name: 'bash', input: {} },
      ]),
      m('user', [{ type: 'tool_result', callId: 'a', content: 'done' }]),
      m('assistant', [{ type: 'tool_call', id: 'c', name: 'bash', input: {} }]),
    ];
    const { messages, inserted } = settleMessages(msgs);
    expect(inserted).toBe(2);
    expect(messages[2]!.content.map((b) => (b as { callId: string }).callId)).toEqual(['b', 'a']);
    expect(messages[4]!.content[0]).toMatchObject({ callId: 'c', content: INTERRUPTED_RESULT, isError: true });
    assertPaired(messages);
    expect(msgs[2]!.content).toHaveLength(1); // input untouched
  });
});
