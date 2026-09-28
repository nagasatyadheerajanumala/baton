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
import { INIT_PROMPT, loadInstructions } from '../../agent/instructions.js';
import { type McpRow, type McpSection, type PickerAccount, PLAN_OPTIONS, renderPlanPrompt, approvalOptions, mcpRows, pickerItems, renderApproval, renderFooter, renderInputBox, renderMcpPanel, renderModelPicker, renderProcBox, renderQueue, renderWorking, serverMenuOptions } from './panels.js';
import { POPULAR, type CatalogEntry, searchRegistry } from '../../mcp/catalog.js';
import { importCandidates, saveServer, setExcluded } from '../../mcp/cli.js';
import { loginToServer, mcpAuthDir } from '../../mcp/client.js';
import { saveModelChoice } from '../../config/config.js';
import type { Entry, TuiStore } from './store.js';

export interface InlineAppProps {
  agent: Agent;
  store: TuiStore;
  version: string;
  /** Config file to save model choices into (absent when running from env vars). */
  configFile?: string;
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
export function InlineApp({ agent, store, version, configFile, onExit }: InlineAppProps) {
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
  const [instructionLabels] = useState(() => loadInstructions(agent.session.cwd).map((f) => f.label.replace(/ \(.*\)$/, '')));
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

  const accounts = useCallback(
    (): PickerAccount[] =>
      router.chain.map((tg, i) => ({
        targetIndex: i,
        label: accountLabel(router, tg),
        model: tg.model,
        current: tg === router.current,
        ...targetState(router, tg),
        models: (tg.models ?? [{ id: tg.model, description: '', contextWindow: tg.contextWindow }]).map((m) => ({ id: m.id, description: m.description })),
      })),
    [router],
  );

  const openPicker = useCallback(() => {
    const items = pickerItems(accounts());
    const at = items.findIndex((it) => it.targetIndex === router.chain.indexOf(router.current) && it.model === router.current.model);
    store.picker = { open: true, index: Math.max(0, at) };
    store.changed();
  }, [accounts, router, store]);

  // ---- MCP panel ------------------------------------------------------------------
  const mcp = agent.mcp;
  const searchTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const searchAbort = useRef<AbortController | undefined>(undefined);

  const mcpSections = useCallback((): McpSection[] => {
    const p = store.mcpPanel;
    const servers = mcp?.servers ?? [];
    const have = new Set(servers.flatMap((s) => [s.name, s.config.url ?? '', `${s.config.command ?? ''} ${(s.config.args ?? []).join(' ')}`.trim()]).filter(Boolean));
    const fresh = (e: CatalogEntry) => !have.has(e.name) && !have.has(e.config.url ?? '\0') && !have.has(`${e.config.command ?? ''} ${(e.config.args ?? []).join(' ')}`.trim() || '\0');
    const q = p.query.trim().toLowerCase();
    const yours: McpRow[] = servers
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .map((s) => ({ kind: 'server', name: s.name, status: s.status, error: s.error, tools: s.tools.length, where: s.origin === 'codex' ? 'from Codex' : s.origin === 'claude' ? 'from Claude Code' : '' }));
    if (q) {
      const local = [...p.imports, ...POPULAR].filter((e) => fresh(e) && (e.name.includes(q) || e.description.toLowerCase().includes(q)));
      const seen = new Set(local.map((e) => e.name));
      return [
        { title: 'Your servers', rows: yours },
        { title: 'Matches', rows: local.map((entry) => ({ kind: 'candidate' as const, entry })) },
        { title: 'MCP registry', rows: p.results.filter((e) => fresh(e) && !seen.has(e.name)).map((entry) => ({ kind: 'candidate' as const, entry })), empty: p.searching ? 'searching…' : 'no results' },
      ];
    }
    // Servers that only run inside Codex go last; the useful ones first.
    const importRows = p.imports.filter(fresh).sort((a, b) => Number(Boolean(a.builtIn)) - Number(Boolean(b.builtIn)));
    const importNames = new Set(importRows.map((e) => e.name));
    return [
      { title: 'Your servers', rows: yours, empty: 'None yet. Pick one below, or type to search.' },
      { title: 'From Codex and Claude Code', rows: importRows.map((entry) => ({ kind: 'candidate' as const, entry })) },
      { title: 'Popular', rows: POPULAR.filter((e) => fresh(e) && !importNames.has(e.name)).map((entry) => ({ kind: 'candidate' as const, entry })) },
    ];
  }, [mcp, store]);

  const openMcp = useCallback(() => {
    const imports: CatalogEntry[] = importCandidates(agent.session.cwd).map((c) => ({
      name: c.name,
      description: '',
      config: c.config,
      origin: c.source,
      builtIn: c.builtIn,
    }));
    store.mcpPanel = { open: true, cursor: 0, query: '', results: [], searching: false, imports };
    store.changed();
  }, [agent.session.cwd, store]);

  const runSearch = useCallback(
    (q: string) => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchAbort.current?.abort();
      if (!q.trim()) {
        store.mcpPanel.results = [];
        store.mcpPanel.searching = false;
        return store.changed();
      }
      store.mcpPanel.searching = true;
      searchTimer.current = setTimeout(() => {
        const ac = new AbortController();
        searchAbort.current = ac;
        searchRegistry(q, { signal: ac.signal })
          .then((results) => {
            if (ac.signal.aborted) return;
            Object.assign(store.mcpPanel, { results, searching: false, error: undefined });
            store.changed();
          })
          .catch((err: Error) => {
            if (ac.signal.aborted) return;
            Object.assign(store.mcpPanel, { searching: false, error: err.message });
            store.changed();
          });
      }, 350);
      store.changed();
    },
    [store],
  );

  const signIn = useCallback(
    async (name: string) => {
      const state = mcp?.servers.find((s) => s.name === name);
      if (!mcp || !state) return;
      store.mcpPanel.busy = `Signing in to ${name}: finish in your browser…`;
      store.changed();
      try {
        const ok = await loginToServer(name, state.config, agent.session.cwd, (line) => {
          const url = /https?:\/\/\S+/.exec(line)?.[0];
          if (url) store.push({ kind: 'notice', level: 'info', text: `Sign in to ${name} in your browser. If it didn't open: ${url}` });
        }, mcpAuthDir());
        const after = await mcp.connect(name);
        store.push({ kind: 'notice', level: after.status === 'connected' ? 'info' : 'warn', text: ok && after.status === 'connected' ? `Signed in to ${name}: ${after.tools.length} tools ready for every model.` : `${name}: ${after.error ?? after.status}` });
      } catch (err) {
        store.push({ kind: 'notice', level: 'error', text: `Sign-in to ${name} failed: ${(err as Error).message}` });
      } finally {
        store.mcpPanel.busy = undefined;
        store.changed();
      }
    },
    [agent.session.cwd, mcp, store],
  );

  const addServer = useCallback(
    async (entry: CatalogEntry) => {
      if (!mcp) return;
      let name = entry.name;
      for (let i = 2; mcp.servers.some((s) => s.name === name); i++) name = `${entry.name}-${i}`;
      const config = { ...entry.config };
      const file = saveServer(agent.session.cwd, name, config);
      mcp.add(name, config);
      store.mcpPanel.busy = `Connecting to ${name}…`;
      store.changed();
      const state = await mcp.connect(name);
      store.mcpPanel.busy = undefined;
      const missingEnv = (entry.needsEnv ?? []).filter((e) => !process.env[e]);
      if (state.status === 'connected') store.push({ kind: 'notice', level: 'info', text: `Added ${name}: ${state.tools.length} tools ready for every model. (saved to ${file.replace(process.env.HOME ?? '~', '~')})` });
      else if (state.status === 'needs-login') {
        store.push({ kind: 'notice', level: 'info', text: `Added ${name}. It needs a one-time sign-in; opening your browser…` });
        void signIn(name);
      } else if (missingEnv.length) store.push({ kind: 'notice', level: 'warn', text: `Added ${name}, but it needs ${missingEnv.join(', ')} set in your environment (e.g. in ~/.zshrc). Then choose Retry in /mcp.` });
      else store.push({ kind: 'notice', level: 'warn', text: `Added ${name}, but it couldn't connect: ${state.error ?? state.status}. Choose Retry in /mcp once it's fixed.` });
      store.changed();
    },
    [agent.session.cwd, mcp, signIn, store],
  );

  const serverAction = useCallback(
    async (name: string, option: string) => {
      if (!mcp) return;
      const p = store.mcpPanel;
      const state = mcp.servers.find((s) => s.name === name);
      if (!state) return;
      if (option === 'View tools') {
        p.menu = { server: name, options: [], index: 0, tools: state.tools.map((tl) => `${tl.name}${tl.readOnly ? t.muted('  read-only') : ''}`) };
        return store.changed();
      }
      p.menu = undefined;
      if (option === 'Sign in') return void signIn(name);
      if (option === 'Hide from baton') {
        await mcp.remove(name);
        setExcluded(agent.session.cwd, name, true);
        store.push({ kind: 'notice', level: 'info', text: `Hid ${name} from baton. It's still set up in ${state.origin === 'codex' ? 'Codex' : 'Claude Code'}.` });
      } else if (option === 'Remove') {
        await mcp.remove(name);
        saveServer(agent.session.cwd, name, undefined);
        store.push({ kind: 'notice', level: 'info', text: `Removed ${name}.` });
      } else if (option === 'Disable' || option === 'Enable') {
        const s = await mcp.setEnabled(name, option === 'Enable');
        if (s) saveServer(agent.session.cwd, name, s.config);
      } else if (option === 'Reconnect' || option === 'Retry') {
        p.busy = `Connecting to ${name}…`;
        store.changed();
        const s = await mcp.connect(name);
        p.busy = undefined;
        if (s.status === 'needs-login') void signIn(name);
      }
      p.cursor = Math.min(p.cursor, Math.max(0, mcpRows(mcpSections()).length - 1));
      store.changed();
    },
    [agent.session.cwd, mcp, mcpSections, signIn, store],
  );

  const submit = useCallback(
    (text: string) => {
      setExitArmed(false);
      if (text === '/model') return openPicker();
      if (text === '/mcp') return openMcp();
      if (text === '/init') return runTurn(INIT_PROMPT, '/init: write AGENTS.md for this project');
      if (text === '/clear') {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        return store.clear();
      }
      if (text.startsWith('/')) {
        const r = runCommand(text, agent, { configFile });
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
      runTurn(text);
    },
    [agent, openPicker, openMcp, requestExit, store, configFile],
  );

  /** Run one request. `shown` is what the transcript displays if it differs from what the model gets. */
  function runTurn(prompt: string, shown?: string) {
      const ac = new AbortController();
      controller.current = ac;
      store.beginTurn(shown ?? prompt);
      agent
        .run(prompt, store.events(), ac.signal)
        .then(() => {
          store.endTurn();
          // A finished plan-mode turn ends with the question: implement it?
          if (store.approvalMode === 'plan' && !ac.signal.aborted && store.queue.length === 0) {
            store.planPrompt = { choice: 0 };
            store.changed();
          }
        })
        .catch((err: Error) => {
          if (ac.signal.aborted || err.name === 'AbortError' || err.name === 'APIUserAbortError') store.endTurn({ message: 'Interrupted. Type what to do next.', level: 'warn' });
          else if (err instanceof AllTargetsExhaustedError) store.endTurn({ message: err.message });
          else store.endTurn({ message: `Error: ${err.message}` });
        })
        .finally(() => {
          if (controller.current === ac) controller.current = null;
        });
  }

  // Send queued follow-ups once the current turn is done.
  useEffect(() => {
    if (!store.running && !store.approval && !store.planPrompt && store.queue.length) {
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

    // Plan approval
    if (store.planPrompt) {
      const pp = store.planPrompt;
      const n = PLAN_OPTIONS.length;
      const choose = (i: number) => {
        store.planPrompt = null;
        if (i === 2) return store.changed(); // keep planning: type feedback next
        store.approvalMode = i === 0 ? 'auto-edit' : 'ask';
        runTurn('The plan is approved. Implement it now, then verify it works.', 'Go ahead with the plan');
      };
      if (key.upArrow) pp.choice = (pp.choice + n - 1) % n;
      else if (key.downArrow) pp.choice = (pp.choice + 1) % n;
      else if (key.return) return choose(pp.choice);
      else if (input === '1' || input === '2' || input === '3') return choose(Number(input) - 1);
      else if (key.escape) return choose(2);
      else if (input && !key.ctrl && !key.meta) {
        // Typing means "keep planning, here's feedback": drop the prompt and let the text through.
        store.planPrompt = null;
        const r = editKey(editor, input, key);
        setEditor(r.state);
      }
      return store.changed();
    }

    // MCP panel
    if (store.mcpPanel.open) {
      const p = store.mcpPanel;
      if (p.menu) {
        const m = p.menu;
        if (key.escape || m.tools) {
          if (key.escape || key.return) p.menu = undefined;
          return store.changed();
        }
        if (key.upArrow) m.index = (m.index + m.options.length - 1) % m.options.length;
        else if (key.downArrow) m.index = (m.index + 1) % m.options.length;
        else if (key.return) return void serverAction(m.server, m.options[m.index]!);
        return store.changed();
      }
      const rows = mcpRows(mcpSections());
      if (key.upArrow) p.cursor = Math.max(0, p.cursor - 1);
      else if (key.downArrow) p.cursor = Math.min(Math.max(0, rows.length - 1), p.cursor + 1);
      else if (key.return) {
        const row = rows[p.cursor];
        if (row?.kind === 'server') {
          const discovered = mcp?.servers.find((s) => s.name === row.name)?.origin !== 'baton';
          const options = serverMenuOptions(row.status).map((o) => (o === 'Remove' && discovered ? 'Hide from baton' : o)).filter((o) => !(discovered && (o === 'Disable' || o === 'Enable')));
          p.menu = { server: row.name, options, index: 0 };
        }
        else if (row?.kind === 'candidate') return void addServer(row.entry);
      } else if (key.escape) {
        if (p.query) {
          p.query = '';
          p.cursor = 0;
          runSearch('');
        } else p.open = false;
      } else if (key.backspace || key.delete) {
        p.query = p.query.slice(0, -1);
        p.cursor = 0;
        runSearch(p.query);
      } else if (input && !key.ctrl && !key.meta && !key.tab && /^[\x20-\x7e]+$/.test(input)) {
        p.query += input;
        p.cursor = 0;
        runSearch(p.query);
      }
      return store.changed();
    }

    // Model picker
    if (store.picker.open) {
      const items = pickerItems(accounts());
      const n = items.length;
      const pick = (i: number) => {
        const it = items[i];
        if (!it) return;
        const target = router.setModel(it.targetIndex, it.model);
        store.picker.open = false;
        const saved = configFile ? saveModelChoice(configFile, target.provider, target.model) : false;
        store.push({
          kind: 'notice',
          level: 'info',
          text: `Now using ${target.model} on ${accountLabel(router, target)}.${saved ? ` Saved as the default for ${accountLabel(router, target)}.` : ''} The conversation carries over.`,
        });
      };
      if (key.upArrow) store.picker.index = (store.picker.index + n - 1) % n;
      else if (key.downArrow) store.picker.index = (store.picker.index + 1) % n;
      else if (key.return) return pick(store.picker.index);
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
  if (store.planPrompt) {
    panel = renderPlanPrompt(store.planPrompt.choice, w - 1);
  } else if (store.approval) {
    panel = renderApproval({ ...store.approval, choice: store.approvalChoice, cwd: agent.session.cwd, cwdLabel: tildify(agent.session.cwd), mode: store.approvalMode }, w - 1);
  } else if (store.picker.open) {
    panel = renderModelPicker(accounts(), store.picker.index, w - 1, now);
  } else if (store.mcpPanel.open) {
    const p = store.mcpPanel;
    panel = renderMcpPanel({ query: p.query, searching: p.searching, searchError: p.error, sections: mcpSections(), cursor: p.cursor, busy: p.busy, menu: p.menu }, w - 1, Math.max(10, rows - 8));
  } else if (procs.open) {
    panel = renderProcBox(agent.processes, { width: w - 1, height: Math.min(16, Math.max(8, rows - 10)), selectedId: procs.selectedId, now, spinner });
  } else {
    const placeholder = store.running ? 'Type a follow-up; it will be sent when this step finishes' : 'Ask baton to…   (/ for commands)';
    panel = renderInputBox(editor.value, editor.cursor, { width: w - 1, placeholder, busy: store.running });
  }

  const slashHint =
    !store.approval && !store.picker.open && !store.mcpPanel.open && !procs.open && editor.value.startsWith('/') && !editor.value.includes(' ')
      ? t.muted(`  ${['/model', '/mcp', '/init', '/memory', '/rewind', '/undo', '/status', '/compact', '/clear', '/help', '/exit'].filter((c) => c.startsWith(editor.value)).join('   ') || 'no matching command'}`)
      : undefined;

  return (
    <>
      <Static key={store.epoch} items={items}>
        {(item) => <Text key={item.key}>{'welcome' in item ? welcomeLines(w - 1, version, instructionLabels).join('\n') : renderEntry(item.entry, { ...ctx, waitingCallId: undefined }).join('\n')}</Text>}
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
