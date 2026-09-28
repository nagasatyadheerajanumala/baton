import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../src/tools/processes.js';
import { editKey, emptyEditor } from '../src/ui/tui/editor.js';
import { cleanOutput, justify, renderEntry, renderInput, renderPane, renderStatus, width } from '../src/ui/tui/format.js';
import { extractMouse, type MouseEvent } from '../src/ui/tui/mouse.js';
import { TuiStore, editDiff } from '../src/ui/tui/store.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('layout primitives', () => {
  it('justify always produces exactly the requested width', () => {
    for (const w of [20, 47, 120]) {
      expect(width(justify('left side text that is fairly long', 'right', w))).toBe(w);
    }
  });

  it('status bar reports the exact columns of the process counter, for mouse hit-testing', () => {
    const s = renderStatus({ model: 'claude-sonnet-5-5', contextPct: 3, tokens: 48200, usd: 0.31, partialCost: false, switches: 1, running: 2, busy: false, paneFocused: false }, 120);
    const plain = strip(s.line);
    expect(width(s.line)).toBe(120);
    expect(plain.slice(s.procCols[0], s.procCols[1])).toBe('⚙ 2 running');
    expect(plain).toContain('48.2k tok · ≈$0.31 · 1 switch');
  });

  it('input line keeps the cursor visible when text is longer than the line', () => {
    const long = 'x'.repeat(300) + 'END';
    const line = strip(renderInput(long, long.length, { width: 80, busy: false, spinner: '', elapsed: '' }));
    expect(line).toContain('END');
    expect(width(line)).toBe(80);
  });

  it('cleans process output: escape codes gone, carriage-return redraws resolved', () => {
    expect(cleanOutput('\x1b[32mok\x1b[0m\nprogress 10%\rprogress 100%\n')).toBe('ok\nprogress 100%\n');
  });

  it('draws a provider switch as one full-width labelled rule', () => {
    const [line] = renderEntry({ kind: 'switch', to: 'anthropic/claude-sonnet-5-5', reason: 'openai quota' }, { width: 90, now: 0, spinner: '', processes: new ProcessManager() });
    expect(width(line!)).toBe(90);
    expect(strip(line!)).toContain('switched to anthropic/claude-sonnet-5-5 · openai quota');
  });
});

describe('edit diffs', () => {
  it('numbers changed lines from the file as it was before the edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-diff-'));
    writeFileSync(join(dir, 'a.js'), 'one\ntwo\nthree\nfour\n');
    const d = editDiff(dir, { path: 'a.js', old_string: 'three', new_string: 'THREE\nthree-and-a-half' });
    expect(d).toMatchObject({ added: 2, removed: 1 });
    expect(d.lines).toEqual([
      { sign: '-', line: 3, text: 'three' },
      { sign: '+', line: 3, text: 'THREE' },
      { sign: '+', line: 4, text: 'three-and-a-half' },
    ]);
  });
});

describe('editor', () => {
  const type = (s: string, st = emptyEditor()) => [...s].reduce((acc, ch) => editKey(acc, ch, {}).state, st);

  it('inserts, moves, deletes words, and submits into history', () => {
    let s = type('hello big world');
    s = editKey(s, 'w', { ctrl: true }).state;
    expect(s.value).toBe('hello big ');
    s = editKey(s, '', { home: true }).state;
    s = editKey(s, '>', {}).state;
    expect(s.value).toBe('>hello big ');
    const r = editKey(s, '', { return: true });
    expect(r.submit).toBe('>hello big');
    expect(r.state.value).toBe('');
    expect(editKey(r.state, '', { upArrow: true }).state.value).toBe('>hello big');
  });

  it('restores the unsent draft after browsing history', () => {
    let s = emptyEditor(['first', 'second']);
    s = type('draft', s);
    s = editKey(s, '', { upArrow: true }).state;
    s = editKey(s, '', { upArrow: true }).state;
    expect(s.value).toBe('first');
    s = editKey(editKey(s, '', { downArrow: true }).state, '', { downArrow: true }).state;
    expect(s.value).toBe('draft');
  });

  it('flattens pasted newlines and drops control characters', () => {
    expect(editKey(emptyEditor(), 'a\nb\r\nc\x07', {}).state.value).toBe('a b c');
  });
});

describe('mouse input', () => {
  it('extracts clicks and wheel events and leaves keystrokes alone', () => {
    const events: MouseEvent[] = [];
    const r = extractMouse('ab\x1b[<0;12;5M\x1b[<0;12;5mcd\x1b[<64;3;9M', (e) => events.push(e));
    expect(r.text).toBe('abcd');
    expect(events).toEqual([
      { type: 'click', x: 12, y: 5, button: 'left' },
      { type: 'wheel', x: 3, y: 9, direction: 'up' },
    ]);
  });

  it('holds back a mouse report split across reads, but not a bare Escape key', () => {
    const events: MouseEvent[] = [];
    const first = extractMouse('x\x1b[<0;4', (e) => events.push(e));
    expect(first).toEqual({ text: 'x', carry: '\x1b[<0;4' });
    const second = extractMouse(first.carry + ';7M', (e) => events.push(e));
    expect(second.text).toBe('');
    expect(events).toEqual([{ type: 'click', x: 4, y: 7, button: 'left' }]);
    expect(extractMouse('\x1b', () => {}).text).toBe('\x1b');
  });
});

describe('process manager and pane', () => {
  it('captures background output, lists processes, and kills the whole process group', async () => {
    const pm = new ProcessManager();
    // The shell spawns a child; killing must take the grandchild with it.
    const proc = pm.start({ command: 'echo started; sleep 30 & wait', cwd: tmpdir(), background: true });
    await until(() => proc.output.includes('started'));
    expect(pm.runningCount).toBe(1);

    const pane = renderPane(pm, { width: 50, height: 12, selectedId: proc.info.id, expanded: false, focused: true, scroll: 0, now: Date.now(), spinner: '⠋' });
    expect(pane.lines).toHaveLength(12);
    const row = [...pane.rowIds.entries()].find(([, id]) => id === proc.info.id)![0];
    expect(strip(pane.lines[row]!)).toContain(`#${proc.info.id}`);
    expect(pane.lines.map(strip).join('\n')).toContain('started');

    pm.kill(proc.info.id, 'SIGTERM', 'killed', 100);
    expect(proc.info.status).toBe('killed');
    expect(pm.runningCount).toBe(0);
  });

  it('times out foreground commands', async () => {
    const pm = new ProcessManager();
    const proc = pm.start({ command: 'sleep 10', cwd: tmpdir(), timeoutMs: 150 });
    await proc.done;
    expect(proc.info.status).toBe('timed_out');
  });

  it('killAll stops everything on exit', async () => {
    const pm = new ProcessManager();
    pm.start({ command: 'sleep 30', cwd: tmpdir(), background: true });
    pm.start({ command: 'sleep 30', cwd: tmpdir(), background: true });
    expect(pm.runningCount).toBe(2);
    pm.killAll();
    expect(pm.runningCount).toBe(0);
  });
});

describe('TuiStore', () => {
  it('holds tool calls for approval and honours "always"', async () => {
    const store = new TuiStore(tmpdir());
    const first = store.approve('$ npm install');
    expect(store.approval?.summary).toBe('$ npm install');
    store.answerApproval('a');
    expect(await first).toBe(true);
    expect(await store.approve('$ rm -rf build')).toBe(true); // "always" sticks for the session
  });

  it('auto-edit mode approves edits but still asks for shell commands', async () => {
    const store = new TuiStore(tmpdir(), 'auto-edit');
    expect(await store.approve('edit src/a.ts')).toBe(true);
    void store.approve('$ make');
    expect(store.approval?.summary).toBe('$ make');
  });

  it('keeps a background process entry alive when the turn ends', () => {
    const store = new TuiStore(tmpdir());
    const ev = store.events();
    store.beginTurn('start the server');
    const call = { type: 'tool_call' as const, id: 'c1', name: 'bash', input: { command: 'npm run dev', background: true } };
    ev.onToolStart!(call, '');
    ev.onToolEnd!(call, { type: 'tool_result', callId: 'c1', content: 'Started background process #4 (pid 1).' });
    store.endTurn();
    const entry = store.entries.find((e) => e.kind === 'tool')!;
    expect(entry).toMatchObject({ status: 'running', procId: 4, summary: 'background #4' });
    expect(entry).not.toHaveProperty('error');
    expect(store.pane.open).toBe(true); // first background process opens the pane
  });

  it('does not reopen the pane after the user closed it', () => {
    const store = new TuiStore(tmpdir());
    store.openPane(false); // user closed
    const ev = store.events();
    const call = { type: 'tool_call' as const, id: 'c1', name: 'bash', input: { command: 'x', background: true } };
    ev.onToolStart!(call, '');
    ev.onToolEnd!(call, { type: 'tool_result', callId: 'c1', content: 'Started background process #1 (pid 1).' });
    expect(store.pane.open).toBe(false);
  });

  it('marks text cut off by a provider switch', () => {
    const store = new TuiStore(tmpdir());
    const ev = store.events();
    store.beginTurn('go');
    ev.onText!('partial answer from the first mod');
    const tgt = { provider: 'openai', model: 'gpt', contextWindow: 1, maxOutputTokens: 1 };
    ev.onSwitch!(tgt, { ...tgt, provider: 'anthropic', model: 'claude' }, { kind: 'quota', message: '' });
    expect(store.entries.find((e) => e.kind === 'assistant')).toMatchObject({ interrupted: true });
  });
});
