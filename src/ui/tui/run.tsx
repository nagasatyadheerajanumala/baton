import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { render } from 'ink';
import type { Agent } from '../../agent/loop.js';
import { runProcess } from '../../tools/process.js';
import { accountLabel } from '../commands.js';
import { App } from './App.js';
import { InlineApp } from './InlineApp.js';
import { MOUSE_OFF, MOUSE_ON, type MouseEvent, mouseFilteredStdin } from './mouse.js';
import type { ApprovalMode, TuiStore } from './store.js';

export interface TuiOptions {
  store: TuiStore;
  version: string;
  mouse: boolean;
  approval: ApprovalMode;
  /** inline (default): scrollback transcript like Claude Code. fullscreen: panes + mouse. */
  layout?: 'inline' | 'fullscreen';
}

async function cwdLabel(cwd: string): Promise<string> {
  const home = homedir();
  let short = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (short.length > 32) short = `…/${short.split('/').slice(-2).join('/')}`;
  const branch = await runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 3_000 }).catch(() => undefined);
  if (!branch || branch.code !== 0) return short;
  const dirty = await runProcess('git', ['status', '--porcelain'], { cwd, timeoutMs: 3_000 }).catch(() => undefined);
  return `${short} · ${branch.output.trim()}${dirty?.output.trim() ? '*' : ''}`;
}

/** Full-screen UI. Resolves when the user exits; all started processes are stopped by then. */
export async function runTui(agent: Agent, opts: TuiOptions): Promise<void> {
  const { store } = opts;
  const router = agent.router;
  store.describe = (tg) => ({ label: accountLabel(router, tg), model: tg.model, plan: router.adapter(tg).external === true });
  store.current = () => router.current;
  if ((opts.layout ?? 'inline') === 'inline') return runInline(agent, opts);
  const mouseBus = new EventEmitter();
  const stdin = opts.mouse ? mouseFilteredStdin(process.stdin, (e) => mouseBus.emit('mouse', e)) : process.stdin;
  const onMouse = opts.mouse
    ? (handler: (e: MouseEvent) => void) => {
        mouseBus.on('mouse', handler);
        return () => void mouseBus.off('mouse', handler);
      }
    : undefined;

  // Process output arrives in bursts; coalesce into at most ~10 renders/s.
  let pending: NodeJS.Timeout | undefined;
  agent.processes.on('change', () => {
    pending ??= setTimeout(() => {
      pending = undefined;
      store.changed();
    }, 100);
  });

  const restoreTerminal = () => {
    if (opts.mouse) process.stdout.write(MOUSE_OFF);
    agent.processes.killAll();
  };
  process.once('exit', restoreTerminal);
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      restoreTerminal();
      process.exit(128 + (sig === 'SIGTERM' ? 15 : 1));
    });
  }

  const label = await cwdLabel(agent.session.cwd);
  const instance = render(
    <App agent={agent} store={store} version={opts.version} cwdLabel={label} onMouse={onMouse} onExit={restoreTerminal} />,
    { stdin, exitOnCtrlC: false, alternateScreen: true, incrementalRendering: true, maxFps: 30, patchConsole: true },
  );
  if (opts.mouse) process.stdout.write(MOUSE_ON);
  await instance.waitUntilExit();
  restoreTerminal();
}

/** Inline layout: no alternate screen, no mouse capture; the terminal keeps its own scrollback. */
async function runInline(agent: Agent, opts: TuiOptions): Promise<void> {
  const { store } = opts;
  let pending: NodeJS.Timeout | undefined;
  agent.processes.on('change', () => {
    pending ??= setTimeout(() => {
      pending = undefined;
      store.changed();
    }, 150);
  });
  const cleanup = () => agent.processes.killAll();
  process.once('exit', cleanup);
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      cleanup();
      process.exit(128 + (sig === 'SIGTERM' ? 15 : 1));
    });
  }
  const instance = render(<InlineApp agent={agent} store={store} version={opts.version} onExit={cleanup} />, {
    exitOnCtrlC: false,
    maxFps: 30,
    patchConsole: true,
  });
  await instance.waitUntilExit();
  cleanup();
}
