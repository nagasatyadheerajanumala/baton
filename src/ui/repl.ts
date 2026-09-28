import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Agent, AgentEvents } from '../agent/loop.js';
import { AllTargetsExhaustedError, targetLabel } from '../router/router.js';
import { c, runCommand } from './commands.js';

/** Terminal event printer shared by the REPL and one-shot mode. */
export function terminalEvents(): AgentEvents & { reset(): void } {
  let midLine = false;
  const line = (s: string) => {
    if (midLine) stdout.write('\n');
    midLine = false;
    stdout.write(s + '\n');
  };
  return {
    reset: () => (midLine = false),
    onText: (d) => {
      stdout.write(d);
      midLine = !d.endsWith('\n');
    },
    onToolStart: (_call, desc) => line(c.dim(`  → ${desc}`)),
    onToolEnd: (_call, r) => {
      if (r.isError) line(c.red(`    ✗ ${r.content.split('\n')[0]?.slice(0, 160)}`));
    },
    onRetry: (t, ms, why) => line(c.yellow(`  ⏳ ${targetLabel(t)}: ${why.kind}, retrying in ${Math.ceil(ms / 1000)}s`)),
    onSwitch: (from, to, why) =>
      line(c.yellow(`  ⇄ ${targetLabel(from)} unavailable (${why.kind}) → switching to ${c.bold(targetLabel(to))}, context preserved`)),
    onCompact: (t, r) =>
      line(c.dim(`  ⊟ compacted history for ${targetLabel(t)} [${r.applied.join(', ')}] ≈${r.estTokens.toLocaleString()} tokens`)),
    onNotice: (m) => line(c.yellow(`  ${m}`)),
  };
}

export function makeApprover(mode: 'ask' | 'auto-edit' | 'plan' | 'yolo', getRl: () => Interface | undefined) {
  return async (summary: string): Promise<boolean> => {
    if (mode === 'yolo') return true;
    if (mode === 'auto-edit' && !summary.startsWith('$ ')) return true;
    const rl = getRl();
    if (!rl) return false; // non-interactive and not pre-approved: deny
    const answer = (await rl.question(c.cyan(`  allow ${summary}? [y/N/a=always] `))).trim().toLowerCase();
    if (answer === 'a') {
      mode = 'yolo';
      return true;
    }
    return answer === 'y' || answer === 'yes';
  };
}

export async function runRepl(agent: Agent, rl: Interface, configSource: string): Promise<void> {
  const events = terminalEvents();
  stdout.write(
    `${c.bold('baton')} ${c.dim(`· ${targetLabel(agent.router.current)} · session ${agent.session.id.slice(0, 8)} · config: ${configSource}`)}\n` +
      c.dim('Type /help for commands. Ctrl-C interrupts the current turn; Ctrl-D exits.\n\n'),
  );

  let controller: AbortController | undefined;
  rl.on('SIGINT', () => {
    if (controller) {
      controller.abort();
      stdout.write(c.yellow('\n  interrupted\n'));
    } else {
      rl.close();
    }
  });

  for (;;) {
    let input: string;
    try {
      input = (await rl.question(c.green('› '))).trim();
    } catch {
      break; // Ctrl-D / closed
    }
    if (!input) continue;

    if (input.startsWith('/')) {
      if (!handleCommand(input, agent)) break;
      continue;
    }

    controller = new AbortController();
    events.reset();
    try {
      await agent.run(input, events, controller.signal);
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError' || e.name === 'APIUserAbortError' || controller.signal.aborted) {
        // already reported
      } else if (err instanceof AllTargetsExhaustedError) {
        stdout.write(c.red(`\n${e.message}\n`));
      } else {
        stdout.write(c.red(`\nError: ${e.message}\n`));
      }
    } finally {
      controller = undefined;
      stdout.write('\n');
    }
  }
  stdout.write(c.dim(`\nSession saved. Resume with: baton --resume ${agent.session.id}\n`));
}

/** Returns false to exit. */
function handleCommand(input: string, agent: Agent): boolean {
  const r = runCommand(input, agent);
  if (r.output) stdout.write(r.output + '\n');
  if (r.clear) stdout.write('\x1bc');
  return !r.exit;
}

export function createRl(): Interface {
  return createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
}
