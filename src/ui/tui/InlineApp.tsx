import { homedir } from 'node:os';
import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Agent } from '../../agent/loop.js';
import { estimateTokens } from '../../compaction/compact.js';
import { sessionCost } from '../../pricing.js';
import { AllTargetsExhaustedError } from '../../router/router.js';
import { accountLabel, pricingOverrides, runCommand, targetState } from '../commands.js';
import { glyph, t } from '../theme.js';
import { type EditorState, editKey, emptyEditor } from './editor.js';
import { renderEntry, welcomeLines, wrap } from './format.js';
import { approvalOptions, renderApproval, renderFooter, renderInputBox, renderPicker, renderProcBox, renderQueue, renderWorking } from './panels.js';
import type { Entry, TuiStore } from './store.js';

export interface InlineAppProps {
  agent: Agent;
  store: TuiStore;
  version: string;
  onExit: () => void;
}

type StaticItem = { key: string; welcome: true } | { key: string; entry: Entry };

const tildify = (p: string) => {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

/**
 * Default UI, modelled on Claude Code and Codex: finished steps are printed
 * once into the terminal's normal scrollback (so native scrolling, selection
 * and search all work), and only the bottom of the screen is live: the step
 * in progress, a working line, queued messages, the prompt or a dialog, and
 * a footer.
 */
export function InlineApp({ agent, store, version, onExit }: InlineAppProps) {
  const { exit } = useApp();
  const { columns: cols, rows } = useWindowSize();
  useSyncExternalStore(
    useCallback((cb) => {
      store.on('change', cb);
      return () => void store.off('change', cb);
    }, [store]),
    () => store.version,
  );

  const [editor, setEditor] = useState<EditorState>(() => emptyEditor());
  const [tick, setTick] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);
  const [procs, setProcs] = useState<{ open: boolean; selectedId?: number }>({ open: false });
  const controller = useRef<AbortController | null>(null);
  const router = agent.router;
  const running = agent.processes.runningCount;
  const w = Math.max(40, cols);

  useEffect(() => {
    if (!store.running && running === 0 && !procs.open) return;
    const id = setInterval(() => setTick((n) => n + 1), store.running ? 100 : 1000);
    return () => clearInterval(id);
  }, [store.running, running, procs.open]);
  const spinner = glyph.spinner[tick % glyph.spinner.length]!;
  const now = Date.now();

  // ---- actions ---------------------------------------------------------------------

  const doExit = useCallback(() => {
    controller.current?.abort();
    onExit();
    exit();
  }, [exit, onExit]);

  const requestExit = useCallback(() => {
    const n = agent.processes.runningCount;
    if (n > 0 && !exitArmed) {
      setExitArmed(true);
      store.push({ kind: 'notice', level: 'warn', text: `${n} process${n === 1 ? ' is' : 'es are'} still running and will be stopped. Press Ctrl+D again to exit.` });
      return;
    }
    doExit();
  }, [agent.processes, exitArmed, store, doExit]);

  const openPicker = useCallback(() => {
    store.picker = { open: true, index: Math.max(0, router.chain.indexOf(router.current)) };
    store.changed();
  }, [router, store]);

  const submit = useCallback(
    (text: string) => {
      setExitArmed(false);
      if (text === '/model') return openPicker();
      if (text === '/clear') {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        return store.clear();
      }
      if (text.startsWith('/')) {
        const r = runCommand(text, agent);
        if (r.exit) return requestExit();
        store.push({ kind: 'command', text });
        if (r.output) store.push({ kind: 'output', text: r.output });
        return;
      }
      if (text.startsWith('!')) {
        const command = text.slice(1).trim();
        if (!command) return;
        const proc = agent.processes.start({ command, cwd: agent.session.cwd, timeoutMs: 120_000 });
        store.push({ kind: 'command', text: `!${command}` });
        void proc.done.then(() => store.push({ kind: 'output', text: t.muted(proc.tail(40) || '(no output)') }));
        return;
      }
      const ac = new AbortController();
      controller.current = ac;
      store.beginTurn(text);
      agent
        .run(text, store.events(), ac.signal)
        .then(() => store.endTurn())
        .catch((err: Error) => {
          if (ac.signal.aborted || err.name === 'AbortError' || err.name === 'APIUserAbortError') store.endTurn({ message: 'Interrupted. Type what to do next.', level: 'warn' });
          else if (err instanceof AllTargetsExhaustedError) store.endTurn({ message: err.message });
          else store.endTurn({ message: `Error: ${err.message}` });
        })
        .finally(() => {
          if (controller.current === ac) controller.current = null;
        });
    },
    [agent, openPicker, requestExit, store],
  );

  // Send queued follow-ups once the current turn is done.
  useEffect(() => {
    if (!store.running && !store.approval && store.queue.length) {
      const next = store.dequeue();
      if (next) submit(next);
    }
  }, [store.version, store.running, submit, store]);

  const expandLastOutput = useCallback(() => {
    const last = [...store.entries].reverse().find((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool' && Boolean(e.output));
    if (!last) return store.push({ kind: 'notice', level: 'info', text: 'No tool output to expand yet.' });
    store.push({ kind: 'command', text: `full output of ${last.verb === 'bash' ? 'Shell' : last.verb}(${last.detail.slice(0, 60)})` });
    store.push({ kind: 'output', text: t.muted(last.output!) });
  }, [store]);

  // ---- keyboard ----------------------------------------------------------------------

  useInput((input, key) => {
    // Permission prompt
    if (store.approval) {
      const n = approvalOptions(store.approval.summary).length;
      const choose = (i: number) => {
        const answer = (['y', 'a', 'n'] as const)[i]!;
        const summary = store.approval?.summary ?? '';
        store.answerApproval(answer);
        if (answer === 'n') store.push({ kind: 'notice', level: 'warn', text: `Denied: ${summary}. Type what it should do instead.` });
      };
      // Only numbers, arrows+enter and esc answer: letter shortcuts are a trap when you're
      // mid-sentence as the prompt appears ("also…" must never mean "allow always").
      if (key.upArrow) store.approvalChoice = (store.approvalChoice + n - 1) % n;
      else if (key.downArrow) store.approvalChoice = (store.approvalChoice + 1) % n;
      else if (key.return) return choose(store.approvalChoice);
      else if (input === '1') return choose(0);
      else if (input === '2') return choose(1);
      else if (input === '3' || key.escape) return choose(2);
      else if (key.ctrl && input === 'c') {
        choose(2);
        controller.current?.abort();
        return;
      }
      return store.changed();
    }

    // Model picker
    if (store.picker.open) {
      const n = router.chain.length;
      const pick = (i: number) => {
        const target = router.setCurrent(String(i));
        store.picker.open = false;
        store.push({ kind: 'notice', level: 'info', text: `Now using ${target.model} (${accountLabel(router, target)}). The conversation carries over.` });
      };
      if (key.upArrow) store.picker.index = (store.picker.index + n - 1) % n;
      else if (key.downArrow) store.picker.index = (store.picker.index + 1) % n;
      else if (key.return) return pick(store.picker.index);
      else if (/^[1-9]$/.test(input) && Number(input) <= n) return pick(Number(input) - 1);
      else if (key.escape || (key.ctrl && input === 'c')) store.picker.open = false;
      return store.changed();
    }

    // Processes panel
    if (procs.open) {
      const list = agent.processes.list();
      const idx = Math.max(0, list.findIndex((p) => p.info.id === procs.selectedId));
      if (key.escape || (key.ctrl && input === 'p')) return setProcs({ open: false });
      if (key.upArrow && list.length) return setProcs({ open: true, selectedId: list[Math.max(0, idx - 1)]!.info.id });
      if (key.downArrow && list.length) return setProcs({ open: true, selectedId: list[Math.min(list.length - 1, idx + 1)]!.info.id });
      if (input === 'k' && list[idx]) return void agent.processes.kill(list[idx].info.id);
      if (input === 'c') return agent.processes.clearFinished();
      return;
    }

    if (key.ctrl && input === 'c') {
      if (controller.current) return controller.current.abort();
      if (editor.value) return setEditor((s) => ({ ...s, value: '', cursor: 0 }));
      if (exitArmed) return doExit();
      setExitArmed(true);
      store.push({ kind: 'notice', level: 'info', text: 'Press Ctrl+C again to exit.' });
      return;
    }
    if (key.ctrl && input === 'd') {
      if (!editor.value) requestExit();
      return;
    }
    if (key.escape) {
      if (controller.current) controller.current.abort();
      return;
    }
    if (key.tab && key.shift) {
      store.cycleMode();
      return;
    }
    if (key.ctrl && input === 'p') return setProcs({ open: true, selectedId: agent.processes.list()[0]?.info.id });
    if (key.ctrl && input === 'o') return expandLastOutput();
    if (key.ctrl && input === 'l') {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      return store.clear();
    }

    const r = editKey(editor, input, key);
    setEditor(r.state);
    if (!r.submit) return;
    // While working, plain messages queue up; commands like /model still act immediately.
    if (store.running && !r.submit.startsWith('/')) store.enqueue(r.submit);
    else submit(r.submit);
  });

  // ---- render --------------------------------------------------------------------------

  const ctx = { width: w - 1, now, spinner, processes: agent.processes, waitingCallId: store.approval?.call?.id };
  const final = store.finalCount();
  store.printed = final;
  const items: StaticItem[] = [{ key: `w${store.epoch}`, welcome: true }, ...store.entries.slice(0, final).map((entry, i) => ({ key: `${store.epoch}-${i}`, entry }))];

  const liveEntries = store.entries.slice(final);
  const liveLines = liveEntries.flatMap((e) => renderEntry(e, ctx));
  if (store.live) liveLines.push(...store.live.split('\n').flatMap((p, i) => wrap(p, w - 3).map((l, j) => (i === 0 && j === 0 ? `${glyph.active} ` : '  ') + l)));
  // Keep the live area on screen; the full text is printed to scrollback when it's done.
  const liveCap = Math.max(4, rows - 18);
  const shownLive = liveLines.length > liveCap ? [t.muted(`  … ${liveLines.length - liveCap} lines above`), ...liveLines.slice(-liveCap)] : liveLines;

  const msgs = agent.session.messages;
  const current = router.current;
  const cost = sessionCost(msgs, pricingOverrides(router));
  const footer = renderFooter(
    {
      model: current.model,
      label: accountLabel(router, current),
      contextLeftPct: Math.max(0, 100 - Math.round((estimateTokens(msgs) / current.contextWindow) * 100)),
      plan: router.adapter(current).external === true,
      usd: cost.usd,
      mode: store.approvalMode,
      running,
      switches: agent.session.switches.length,
    },
    w - 1,
  );

  let panel: string[];
  if (store.approval) {
    panel = renderApproval({ ...store.approval, choice: store.approvalChoice, cwd: agent.session.cwd, cwdLabel: tildify(agent.session.cwd), mode: store.approvalMode }, w - 1);
  } else if (store.picker.open) {
    const rowsInfo = router.chain.map((tg) => ({ model: tg.model, label: accountLabel(router, tg), ...targetState(router, tg) }));
    panel = renderPicker(rowsInfo, store.picker.index, w - 1, now);
  } else if (procs.open) {
    panel = renderProcBox(agent.processes, { width: w - 1, height: Math.min(16, Math.max(8, rows - 10)), selectedId: procs.selectedId, now, spinner });
  } else {
    const placeholder = store.running ? 'Type a follow-up; it will be sent when this step finishes' : 'Ask baton to…   (/ for commands)';
    panel = renderInputBox(editor.value, editor.cursor, { width: w - 1, placeholder, busy: store.running });
  }

  const slashHint =
    !store.approval && !store.picker.open && !procs.open && editor.value.startsWith('/') && !editor.value.includes(' ')
      ? t.muted(`  ${['/model', '/status', '/compact', '/clear', '/help', '/exit'].filter((c) => c.startsWith(editor.value)).join('   ') || 'no matching command'}`)
      : undefined;

  return (
    <>
      <Static key={store.epoch} items={items}>
        {(item) => <Text key={item.key}>{'welcome' in item ? welcomeLines(w - 1, version).join('\n') : renderEntry(item.entry, { ...ctx, waitingCallId: undefined }).join('\n')}</Text>}
      </Static>
      <Box flexDirection="column" width={w}>
        {shownLive.length > 0 && <Text>{shownLive.join('\n')}</Text>}
        {store.running && !store.approval && <Text>{renderWorking({ spinner, elapsedMs: now - store.turnStartedAt, width: w - 1, queued: store.queue.length })}</Text>}
        {store.queue.length > 0 && <Text>{renderQueue(store.queue, w - 1).join('\n')}</Text>}
        <Text>{panel.join('\n')}</Text>
        {slashHint ? <Text>{slashHint}</Text> : <Text>{footer}</Text>}
      </Box>
    </>
  );
}
