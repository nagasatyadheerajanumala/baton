import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Agent, AgentEvents } from '../agent/loop.js';
import { compact, estimateTokens } from '../compaction/compact.js';
import { touchedFiles } from '../ir/session.js';
import { AllTargetsExhaustedError, targetLabel } from '../router/router.js';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const HELP = `Commands:
  /model [name|index]  show the failover chain, or switch to a model manually
  /status              session, token and cooldown info
  /compact             preview what compaction would do for the current model
  /help                this message
  /exit                quit (session is saved; resume with --resume <id>)`;

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

export function makeApprover(mode: 'ask' | 'auto-edit' | 'yolo', getRl: () => Interface | undefined) {
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
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const router = agent.router;

  switch (cmd) {
    case 'exit':
    case 'quit':
      return false;
    case 'help':
      stdout.write(HELP + '\n');
      break;
    case 'model':
      if (arg) {
        try {
          const t = router.setCurrent(arg);
          stdout.write(`Switched to ${c.bold(targetLabel(t))}. History carries over.\n`);
        } catch (e) {
          stdout.write(c.red((e as Error).message) + '\n');
        }
      } else {
        router.chain.forEach((t, i) => {
          const cur = t === router.current ? c.green('●') : ' ';
          const cd = router.cooldownRemaining(t);
          const cool = cd === 0 ? '' : c.yellow(Number.isFinite(cd) ? ` (cooling down ${Math.ceil(cd / 1000)}s)` : ' (disabled: bad key or model id — run baton doctor)');
          stdout.write(`${cur} ${i}  ${targetLabel(t)}  ${c.dim(`${(t.contextWindow / 1000).toFixed(0)}k ctx`)}${cool}\n`);
        });
      }
      break;
    case 'status': {
      const msgs = agent.session.messages;
      const usage = msgs.reduce(
        (a, m) => ({ i: a.i + (m.meta.usage?.inputTokens ?? 0), o: a.o + (m.meta.usage?.outputTokens ?? 0) }),
        { i: 0, o: 0 },
      );
      stdout.write(
        [
          `session   ${agent.session.id}`,
          `model     ${targetLabel(router.current)}`,
          `history   ${msgs.length} messages, ≈${estimateTokens(msgs).toLocaleString()} tokens`,
          `billed    ${usage.i.toLocaleString()} in / ${usage.o.toLocaleString()} out (reported by providers)`,
          `switches  ${agent.session.switches.map((s) => `${s.from}→${s.to} (${s.reason})`).join(', ') || 'none'}`,
          `files     ${touchedFiles(msgs).join(', ') || 'none modified'}`,
        ].join('\n') + '\n',
      );
      break;
    }
    case 'compact': {
      const t = router.current;
      const budget = Math.floor((t.contextWindow - t.maxOutputTokens) * 0.9);
      const before = estimateTokens(agent.session.messages);
      const r = compact(agent.session.messages, { budgetTokens: Number(arg) || budget });
      stdout.write(
        `≈${before.toLocaleString()} → ≈${r.estTokens.toLocaleString()} tokens (budget ${(Number(arg) || budget).toLocaleString()}); ` +
          `passes: ${r.applied.join(', ') || 'none needed'}\n` +
          c.dim('Compaction is applied automatically per request; the saved session keeps full history.\n'),
      );
      break;
    }
    default:
      stdout.write(c.red(`Unknown command /${cmd}. `) + 'Try /help.\n');
  }
  return true;
}

export function createRl(): Interface {
  return createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
}
