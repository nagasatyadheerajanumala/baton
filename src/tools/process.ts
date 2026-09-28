import { spawn } from 'node:child_process';

export interface ProcessResult {
  output: string;
  code: number | null;
  timedOut: boolean;
}

/** Run a command, merging stdout/stderr in arrival order, capped in memory. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxBytes?: number },
): Promise<ProcessResult> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so timeout kills children too
    });
    let out = '';
    let timedOut = false;
    const onData = (d: Buffer) => {
      if (out.length < maxBytes) out += d.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ output: out, code, timedOut });
    });
  });
}
