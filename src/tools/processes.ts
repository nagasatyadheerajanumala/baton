import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type ProcStatus = 'running' | 'exited' | 'killed' | 'timed_out' | 'failed';

export interface ProcInfo {
  id: number;
  command: string;
  cwd: string;
  pid: number | undefined;
  background: boolean;
  status: ProcStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
}

const MAX_OUTPUT_CHARS = 256_000;

/** One shell command started by a tool. Keeps a bounded tail of its output. */
export class ManagedProcess {
  readonly info: ProcInfo;
  /** Chars dropped from the front once output exceeded the cap. */
  droppedChars = 0;
  private buf = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  child?: ChildProcess;

  constructor(info: ProcInfo) {
    this.info = info;
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get output(): string {
    return this.buf;
  }
  get running(): boolean {
    return this.info.status === 'running';
  }

  /** Last `n` lines of output. */
  tail(n: number): string {
    const lines = this.buf.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).join('\n');
  }

  append(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_OUTPUT_CHARS) {
      const cut = this.buf.length - MAX_OUTPUT_CHARS;
      this.buf = this.buf.slice(cut);
      this.droppedChars += cut;
    }
  }

  finish(status: ProcStatus, exitCode: number | null): void {
    if (!this.running) return;
    this.info.status = status;
    this.info.exitCode = exitCode;
    this.info.endedAt = Date.now();
    this.resolveDone();
  }
}

export interface StartOptions {
  command: string;
  cwd: string;
  background?: boolean;
  /** Foreground only; background processes run until killed or baton exits. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Registry of every shell command the agent starts (foreground and
 * background). The TUI's process pane renders straight from this; tools use
 * it to start, inspect and stop processes. Emits `change` (throttle in the UI).
 */
export class ProcessManager extends EventEmitter {
  private readonly procs = new Map<number, ManagedProcess>();
  private nextId = 1;
  /** Finished processes kept for inspection. */
  private readonly keepFinished = 30;

  list(): ManagedProcess[] {
    return [...this.procs.values()].sort((a, b) => b.info.id - a.info.id);
  }
  get(id: number): ManagedProcess | undefined {
    return this.procs.get(id);
  }
  get runningCount(): number {
    let n = 0;
    for (const p of this.procs.values()) if (p.running) n++;
    return n;
  }

  start(opts: StartOptions): ManagedProcess {
    const proc = new ManagedProcess({
      id: this.nextId++,
      command: opts.command,
      cwd: opts.cwd,
      pid: undefined,
      background: opts.background ?? false,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
    });
    this.procs.set(proc.info.id, proc);
    this.prune();

    const child = spawn('bash', ['-c', opts.command], {
      cwd: opts.cwd,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', FORCE_COLOR: '0', CI: process.env.CI ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group: kill() takes children (npm -> node) with it
    });
    proc.child = child;
    proc.info.pid = child.pid;
    const onData = (d: Buffer) => {
      proc.append(d.toString('utf8'));
      this.emit('change', proc.info.id);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);

    let timer: NodeJS.Timeout | undefined;
    if (!proc.info.background && opts.timeoutMs) {
      timer = setTimeout(() => this.kill(proc.info.id, 'SIGKILL', 'timed_out'), opts.timeoutMs);
    }
    const onAbort = () => this.kill(proc.info.id, 'SIGKILL', 'killed');
    if (!proc.info.background) opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      proc.append(`\n${e.message}\n`);
      proc.finish('failed', null);
      this.emit('change', proc.info.id);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      proc.finish('exited', code);
      this.emit('change', proc.info.id);
    });
    this.emit('change', proc.info.id);
    return proc;
  }

  /** SIGTERM the process group, escalating to SIGKILL after `graceMs`. */
  kill(id: number, signal: NodeJS.Signals = 'SIGTERM', as: ProcStatus = 'killed', graceMs = 2_000): boolean {
    const proc = this.procs.get(id);
    if (!proc?.running || !proc.info.pid) return false;
    const pid = proc.info.pid;
    const send = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          proc.child?.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    proc.finish(as, null);
    send(signal);
    if (signal !== 'SIGKILL') setTimeout(() => send('SIGKILL'), graceMs).unref();
    this.emit('change', id);
    return true;
  }

  /** Called on exit: nothing baton started should outlive it. */
  killAll(): void {
    for (const p of this.procs.values()) if (p.running) this.kill(p.info.id, 'SIGKILL');
  }

  clearFinished(): void {
    for (const [id, p] of this.procs) if (!p.running) this.procs.delete(id);
    this.emit('change', 0);
  }

  private prune(): void {
    const finished = this.list().filter((p) => !p.running);
    for (const p of finished.slice(this.keepFinished)) this.procs.delete(p.info.id);
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function statusLabel(p: ProcInfo): string {
  switch (p.status) {
    case 'running':
      return 'running';
    case 'exited':
      return `exit ${p.exitCode}`;
    case 'timed_out':
      return 'timed out';
    default:
      return p.status;
  }
}
