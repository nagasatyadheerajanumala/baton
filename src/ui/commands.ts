import type { Agent } from '../agent/loop.js';
import { compact, estimateTokens } from '../compaction/compact.js';
import { touchedFiles } from '../ir/session.js';
import { sessionCost } from '../pricing.js';
import { MissingKeyAdapter } from '../providers/registry.js';
import { type Router, type Target, targetLabel } from '../router/router.js';

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

export const HELP = `Commands:
  /model [name|index]  show the failover chain, or switch to a model manually
  /status              session, token and cost info
  /compact [tokens]    preview what compaction would do for the current model
  /clear               clear the screen (history is kept)
  /help                this message
  /exit                quit (session is saved; resume with --resume <id>)`;

export interface CommandResult {
  output: string;
  exit?: boolean;
  clear?: boolean;
}

export type TargetState = 'active' | 'ready' | 'cooldown' | 'disabled' | 'no-key';

/** Shared by the chain panel and /model. */
export function targetState(router: Router, t: Target): { state: TargetState; cooldownMs: number } {
  const cooldownMs = router.cooldownRemaining(t);
  if (router.adapter(t) instanceof MissingKeyAdapter) return { state: 'no-key', cooldownMs };
  if (!Number.isFinite(cooldownMs)) return { state: 'disabled', cooldownMs };
  if (t === router.current) return { state: 'active', cooldownMs };
  return { state: cooldownMs > 0 ? 'cooldown' : 'ready', cooldownMs };
}

/** "ChatGPT plan", "Claude API", ... for a chain entry. */
export function accountLabel(router: Router, t: Target): string {
  return router.adapter(t).label ?? t.provider;
}

export function pricingOverrides(router: Router) {
  return Object.fromEntries(router.chain.map((t) => [t.model, t.pricing]));
}

export function runCommand(input: string, agent: Agent): CommandResult {
  const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  const router = agent.router;

  switch (cmd) {
    case 'exit':
    case 'quit':
      return { output: '', exit: true };
    case 'help':
      return { output: HELP };
    case 'clear':
      return { output: '', clear: true };
    case 'model': {
      if (arg) {
        try {
          const t = router.setCurrent(arg);
          return { output: `Switched to ${c.bold(targetLabel(t))}. History carries over.` };
        } catch (e) {
          return { output: c.red((e as Error).message) };
        }
      }
      const lines = router.chain.map((t, i) => {
        const { state, cooldownMs } = targetState(router, t);
        const mark = state === 'active' ? c.green('●') : ' ';
        const note =
          state === 'cooldown' ? c.yellow(` (cooling down ${Math.ceil(cooldownMs / 1000)}s)`)
          : state === 'disabled' ? c.red(' (disabled: bad key or model id; run baton doctor)')
          : state === 'no-key' ? c.red(' (no API key)')
          : '';
        return `${mark} ${i}  ${targetLabel(t)}  ${c.dim(`${Math.round(t.contextWindow / 1000)}k ctx`)}${note}`;
      });
      return { output: lines.join('\n') };
    }
    case 'status': {
      const msgs = agent.session.messages;
      const cost = sessionCost(msgs, pricingOverrides(router));
      return {
        output: [
          `session   ${agent.session.id}`,
          `model     ${targetLabel(router.current)}`,
          `history   ${msgs.length} messages, ≈${estimateTokens(msgs).toLocaleString()} tokens`,
          `usage     ${cost.inputTokens.toLocaleString()} in / ${cost.outputTokens.toLocaleString()} out` +
            ` · ≈$${cost.usd.toFixed(2)}${cost.partial ? ' (some models unpriced)' : ''}`,
          `switches  ${agent.session.switches.map((s) => `${s.from}→${s.to} (${s.reason})`).join(', ') || 'none'}`,
          `files     ${touchedFiles(msgs).join(', ') || 'none modified'}`,
        ].join('\n'),
      };
    }
    case 'compact': {
      const t = router.current;
      const budget = Number(arg) || Math.floor((t.contextWindow - t.maxOutputTokens) * 0.9);
      const before = estimateTokens(agent.session.messages);
      const r = compact(agent.session.messages, { budgetTokens: budget });
      return {
        output:
          `≈${before.toLocaleString()} → ≈${r.estTokens.toLocaleString()} tokens (budget ${budget.toLocaleString()}); ` +
          `passes: ${r.applied.join(', ') || 'none needed'}\n` +
          c.dim('Compaction is applied automatically per request; the saved session keeps full history.'),
      };
    }
    default:
      return { output: `${c.red(`Unknown command /${cmd}.`)} Try /help.` };
  }
}
