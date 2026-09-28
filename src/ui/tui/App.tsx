import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Agent } from '../../agent/loop.js';
import { estimateTokens } from '../../compaction/compact.js';
import { sessionCost } from '../../pricing.js';
import { AllTargetsExhaustedError } from '../../router/router.js';
import { formatDuration } from '../../tools/processes.js';
import { pricingOverrides, runCommand, targetState } from '../commands.js';
import { glyph, t } from '../theme.js';
import { type EditorState, editKey, emptyEditor } from './editor.js';
import { renderConversation, renderHeader, renderInput, renderPane, renderStatus, truncate } from './format.js';
import type { MouseEvent } from './mouse.js';
import type { TuiStore } from './store.js';

export interface AppProps {
  agent: Agent;
  store: TuiStore;
  version: string;
  cwdLabel: string;
  /** Subscribe to mouse events; returns an unsubscribe function. */
  onMouse?: (handler: (e: MouseEvent) => void) => () => void;
  onExit: () => void;
}

const SLASH_COMMANDS = ['/model', '/status', '/compact', '/clear', '/help', '/exit'];
const WIDE = 100; // below this, the process pane overlays the conversation instead of splitting

export function App({ agent, store, version, cwdLabel, onMouse, onExit }: AppProps) {
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
  const [pendingExit, setPendingExit] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const layout = useRef({ leftW: 0, mainTop: 3, mainH: 0, paneX: 0, rowIds: new Map<number, number>(), closeCols: [0, 0] as [number, number], statusY: 0, procCols: [0, 0] as [number, number] });

  const running = agent.processes.runningCount;
  // Animate only while something is moving.
  useEffect(() => {
    if (!store.running && running === 0 && !store.approval) return;
    const id = setInterval(() => setTick((n) => n + 1), store.running ? 100 : 1000);
    return () => clearInterval(id);
  }, [store.running, running, store.approval]);

  const spinner = glyph.spinner[tick % glyph.spinner.length]!;
  const now = Date.now();
  const pane = store.pane;
  const wide = cols >= WIDE;
  const paneW = pane.open ? (wide ? Math.max(40, Math.floor(cols * 0.42)) : cols) : 0;
  const leftW = pane.open ? (wide ? cols - paneW - 1 : 0) : cols;
  const mainH = Math.max(3, rows - 6);

  // ---- actions ---------------------------------------------------------------------

  const doExit = useCallback(() => {
    controller.current?.abort();
    onExit();
    exit();
  }, [exit, onExit]);

  const requestExit = useCallback(() => {
    if (agent.processes.runningCount > 0 && !pendingExit) {
      setPendingExit(true);
      const n = agent.processes.runningCount;
      store.push({ kind: 'notice', level: 'warn', text: `${n} process${n === 1 ? ' is' : 'es are'} still running and will be stopped. Press ^D again to exit.` });
      return;
    }
    doExit();
  }, [agent.processes, pendingExit, store, doExit]);

  const submit = useCallback(
    (text: string) => {
      setPendingExit(false);
      if (text.startsWith('/')) {
        const r = runCommand(text, agent);
        if (r.exit) return requestExit();
        if (r.clear) return store.clear();
        store.push({ kind: 'command', text });
        store.push({ kind: 'output', text: r.output });
        return;
      }
      if (text.startsWith('!')) {
        const command = text.slice(1).trim();
        if (!command) return;
        const proc = agent.processes.start({ command, cwd: agent.session.cwd, timeoutMs: 120_000 });
        store.push({ kind: 'command', text: `!${command}  #${proc.info.id}` });
        void proc.done.then(() => {
          store.push({ kind: 'output', text: proc.tail(40) || t.muted('(no output)') });
        });
        return;
      }
      const ac = new AbortController();
      controller.current = ac;
      store.beginTurn(text);
      agent
        .run(text, store.events(), ac.signal)
        .then(() => store.endTurn())
        .catch((err: Error) => {
          if (ac.signal.aborted || err.name === 'AbortError' || err.name === 'APIUserAbortError') store.endTurn({ message: 'Interrupted.', level: 'warn' });
          else if (err instanceof AllTargetsExhaustedError) store.endTurn({ message: err.message });
          else store.endTurn({ message: `Error: ${err.message}` });
        })
        .finally(() => {
          if (controller.current === ac) controller.current = null;
        });
    },
    [agent, requestExit, store],
  );

  const selectProcess = useCallback(
    (delta: number) => {
      const list = agent.processes.list();
      if (!list.length) return;
      const idx = Math.max(0, list.findIndex((p) => p.info.id === pane.selectedId));
      const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))]!;
      pane.selectedId = next.info.id;
      pane.scroll = 0;
      store.changed();
    },
    [agent.processes, pane, store],
  );

  // ---- keyboard -------------------------------------------------------------------------

  useInput((input, key) => {
    if (store.approval) {
      const a = input.toLowerCase();
      if (a === 'y' || a === 'n' || a === 'a') store.answerApproval(a);
      else if (key.escape || (key.ctrl && input === 'c')) {
        store.answerApproval('n');
        controller.current?.abort();
      }
      return;
    }

    if (key.ctrl && input === 'c') {
      if (controller.current) return controller.current.abort();
      if (editor.value) return setEditor((s) => ({ ...s, value: '', cursor: 0 }));
      return requestExit();
    }
    if (key.ctrl && input === 'd') {
      if (!store.running && !editor.value) requestExit();
      return;
    }
    if (key.ctrl && input === 'p') return store.openPane(!pane.open);
    if (key.ctrl && input === 'l') return store.clear();
    if (key.pageUp || (key.shift && key.upArrow)) {
      if (pane.focused) pane.scroll += Math.max(1, mainH - 4);
      else store.scroll += key.pageUp ? Math.max(1, mainH - 2) : 1;
      return store.changed();
    }
    if (key.pageDown || (key.shift && key.downArrow)) {
      if (pane.focused) pane.scroll = Math.max(0, pane.scroll - Math.max(1, mainH - 4));
      else store.scroll = Math.max(0, store.scroll - (key.pageDown ? Math.max(1, mainH - 2) : 1));
      return store.changed();
    }
    if (key.escape) {
      if (pane.expanded) {
        pane.expanded = false;
        return store.changed();
      }
      if (pane.open) return store.openPane(false);
      return;
    }
    if (key.tab && pane.open) {
      pane.focused = !pane.focused;
      if (pane.focused && pane.selectedId === undefined) pane.selectedId = agent.processes.list()[0]?.info.id;
      return store.changed();
    }

    if (pane.focused) {
      if (key.upArrow) return selectProcess(-1);
      if (key.downArrow) return selectProcess(1);
      if (key.return) {
        pane.expanded = !pane.expanded;
        return store.changed();
      }
      if (input === 'k' && pane.selectedId !== undefined) {
        agent.processes.kill(pane.selectedId);
        return;
      }
      if (input === 'c') {
        agent.processes.clearFinished();
        return;
      }
      return;
    }

    if (store.running) return; // typing ahead / queued messages: roadmap P0
    const r = editKey(editor, input, key);
    setEditor(r.state);
    if (r.submit) submit(r.submit);
  });

  // ---- mouse ------------------------------------------------------------------------------

  useEffect(() => {
    if (!onMouse) return;
    return onMouse((e) => {
      const L = layout.current;
      const inMain = e.y >= L.mainTop && e.y < L.mainTop + L.mainH;
      const inPane = store.pane.open && e.x >= L.paneX;
      if (e.type === 'wheel') {
        if (inMain && inPane) store.pane.scroll = Math.max(0, store.pane.scroll + (e.direction === 'up' ? 3 : -3));
        else if (inMain) store.scroll = Math.max(0, store.scroll + (e.direction === 'up' ? 3 : -3));
        return store.changed();
      }
      if (e.button !== 'left') return;
      if (e.y === L.statusY && e.x - 1 >= L.procCols[0] && e.x - 1 < L.procCols[1]) return store.openPane(!store.pane.open);
      if (inMain && inPane) {
        const row = e.y - L.mainTop;
        const col = e.x - L.paneX;
        if (row === 0 && col >= L.closeCols[0] - 1) return store.openPane(false);
        const id = L.rowIds.get(row);
        if (id !== undefined) {
          if (store.pane.selectedId === id && store.pane.focused) store.pane.expanded = !store.pane.expanded;
          store.pane.selectedId = id;
          store.pane.focused = true;
          store.pane.scroll = 0;
          return store.changed();
        }
        store.pane.focused = true;
        return store.changed();
      }
      if (inMain && store.pane.focused) {
        store.pane.focused = false;
        store.changed();
      }
    });
  }, [onMouse, store]);

  // ---- render -------------------------------------------------------------------------------

  const convWidth = Math.max(10, leftW - 2);
  const convLines = useMemo(
    () => (leftW > 0 ? renderConversation(store.entries, store.live, { width: convWidth, now, spinner, processes: agent.processes }, version) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.version, convWidth, tick, leftW],
  );
  const maxScroll = Math.max(0, convLines.length - mainH);
  if (store.scroll > maxScroll) store.scroll = maxScroll;
  const end = convLines.length - store.scroll;
  const visible = convLines.slice(Math.max(0, end - mainH), end);
  if (store.scroll > 0 && visible.length) visible[visible.length - 1] = t.muted(`  ↓ ${store.scroll} more lines  (PgDn)`);
  while (visible.length < mainH) visible.push('');

  const paneLayout = pane.open
    ? renderPane(agent.processes, { width: paneW - (wide ? 1 : 0), height: mainH, selectedId: pane.selectedId, expanded: pane.expanded, focused: pane.focused, scroll: pane.scroll, now, spinner })
    : undefined;

  const router = agent.router;
  const chain = router.chain.map((tg) => ({ model: tg.model, state: targetState(router, tg).state }));
  const msgs = agent.session.messages;
  const cost = sessionCost(msgs, pricingOverrides(router));
  const status = renderStatus(
    {
      model: router.current.model,
      contextPct: Math.min(100, Math.round((estimateTokens(msgs) / router.current.contextWindow) * 100)),
      tokens: cost.inputTokens + cost.outputTokens,
      usd: cost.usd,
      partialCost: cost.partial,
      switches: agent.session.switches.length,
      running,
      busy: store.running,
      paneFocused: pane.focused,
      plan: router.adapter(router.current).external === true,
    },
    cols,
  );

  const slashHint = editor.value.startsWith('/') && !editor.value.includes(' ')
    ? t.muted(SLASH_COMMANDS.filter((c) => c.startsWith(editor.value)).join('  ') || 'no matching command')
    : undefined;
  const inputLine = renderInput(editor.value, editor.cursor, {
    width: cols,
    busy: store.running,
    spinner,
    elapsed: formatDuration(now - store.turnStartedAt),
    approval: store.approval?.summary,
    hint: slashHint,
  });

  layout.current = {
    leftW,
    mainTop: 3,
    mainH,
    paneX: wide ? leftW + 2 : 1,
    rowIds: paneLayout?.rowIds ?? new Map(),
    closeCols: paneLayout?.closeCols ?? [0, 0],
    statusY: rows,
    procCols: status.procCols,
  };

  const rule = t.rule('─'.repeat(cols));
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Text wrap="truncate">{renderHeader(cwdLabel, chain, cols)}</Text>
      <Text wrap="truncate">{rule}</Text>
      <Box flexDirection="row" height={mainH}>
        {leftW > 0 && (
          <Box width={leftW} paddingLeft={1} flexDirection="column">
            <Text wrap="truncate">{visible.map((l) => truncate(l, convWidth + 1)).join('\n')}</Text>
          </Box>
        )}
        {paneLayout && wide && (
          <Box width={1} flexDirection="column">
            <Text>{Array.from({ length: mainH }, () => t.rule('│')).join('\n')}</Text>
          </Box>
        )}
        {paneLayout && (
          <Box width={paneW - (wide ? 1 : 0)} flexDirection="column">
            <Text wrap="truncate">{paneLayout.lines.join('\n')}</Text>
          </Box>
        )}
      </Box>
      <Text wrap="truncate">{rule}</Text>
      <Text wrap="truncate">{inputLine}</Text>
      <Text wrap="truncate">{rule}</Text>
      <Text wrap="truncate">{status.line}</Text>
    </Box>
  );
}

