import type { Agent } from '../agent/loop.js';
import { compact, estimateTokens } from '../compaction/compact.js';
import { touchedFiles } from '../ir/session.js';
import { sessionCost } from '../pricing.js';
import { loadCommands, loadSkills } from '../agent/extensions.js';
import { loadInstructions } from '../agent/instructions.js';
import { saveModelChoice } from '../config/config.js';
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
  /mcp                 MCP servers and their tools
  /init                write or improve AGENTS.md for this project
  /memory              instruction files every model is following
  /rewind, /undo       restore files from before an earlier request
  /skills              skills every model can use (run one as /name)
  /hooks, /trust       hooks that run automatically; trust this project's hooks
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

/** Switch by model id (any model on any account), account label, or chain index. */
export function switchModel(router: Router, query: string): Target {
  const q = query.trim().toLowerCase();
  const byModel = router.chain.findIndex((t) => t.models?.some((m) => m.id.toLowerCase() === q) || t.model.toLowerCase() === q);
  if (byModel >= 0) {
    const id = router.chain[byModel]!.models?.find((m) => m.id.toLowerCase() === q)?.id ?? router.chain[byModel]!.model;
    return router.setModel(byModel, id);
  }
  const byLabel = router.chain.findIndex((t) => accountLabel(router, t).toLowerCase() === q || t.provider.toLowerCase() === q);
  if (byLabel >= 0) return router.setCurrent(String(byLabel));
  const partial = router.chain.flatMap((t, i) => (t.models ?? []).filter((m) => m.id.toLowerCase().includes(q)).map((m) => ({ i, id: m.id })));
  if (partial.length === 1) return router.setModel(partial[0]!.i, partial[0]!.id);
  if (partial.length > 1) throw new Error(`"${query}" matches ${partial.map((p) => p.id).join(', ')}; be more specific.`);
  return router.setCurrent(query);
}

export function runCommand(input: string, agent: Agent, opts: { configFile?: string } = {}): CommandResult {
  const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  const router = agent.router;

  switch (cmd) {
    case 'exit':
    case 'quit':
      return { output: '', exit: true };
    case 'help': {
      const custom = loadCommands(agent.session.cwd);
      const extra = custom.length ? `\n\nYour commands:\n${custom.map((x) => `  /${x.name}${x.argumentHint ? ` ${x.argumentHint}` : ''}  ${c.dim(x.description.slice(0, 80))}`).join('\n')}` : '';
      const skills = loadSkills(agent.session.cwd).length;
      return { output: `${HELP}${extra}${skills ? `\n\n${skills} skills installed: /skills lists them; run one as /name.` : ''}` };
    }
    case 'clear':
      return { output: '', clear: true };
    case 'model': {
      if (arg) {
        try {
          const t = switchModel(router, arg);
          const saved = opts.configFile ? saveModelChoice(opts.configFile, t.provider, t.model) : false;
          return { output: `Now using ${c.bold(t.model)} on ${accountLabel(router, t)}.${saved ? ' Saved as its default.' : ''} The conversation carries over.` };
        } catch (e) {
          return { output: c.red((e as Error).message) };
        }
      }
      const lines: string[] = [];
      router.chain.forEach((t, i) => {
        const { state, cooldownMs } = targetState(router, t);
        const note =
          state === 'active' ? c.green(' (in use)')
          : state === 'cooldown' ? c.yellow(` (limit reached, back in ${Math.ceil(cooldownMs / 60_000)} min)`)
          : state === 'disabled' ? c.red(' (unavailable; run baton doctor)')
          : state === 'no-key' ? c.red(' (no API key)')
          : '';
        lines.push(`${c.bold(accountLabel(router, t))}${note}`);
        for (const m of t.models ?? [{ id: t.model, description: '' }]) {
          lines.push(`  ${m.id === t.model ? c.green('●') : ' '} ${m.id.padEnd(20)} ${c.dim(m.description)}`);
        }
        if (i < router.chain.length - 1) lines.push('');
      });
      lines.push('', c.dim('Switch with /model <name>, e.g. /model claude-sonnet-5-5'));
      return { output: lines.join('\n') };
    }
    case 'skills': {
      const skills = loadSkills(agent.session.cwd);
      if (!skills.length) return { output: 'No skills installed. baton reads ~/.claude/skills, ~/.agents/skills, ~/.codex/skills and .claude/skills in the project.' };
      const byOrigin = new Map<string, typeof skills>();
      for (const s of skills) byOrigin.set(s.origin, [...(byOrigin.get(s.origin) ?? []), s]);
      const where: Record<string, string> = { project: 'this project', claude: '~/.claude/skills', agents: '~/.agents/skills', codex: '~/.codex/skills', baton: '~/.baton/skills' };
      const lines = [`${skills.length} skills; every model loads one when a task calls for it, or run one yourself as /name.`];
      for (const [origin, list] of byOrigin) {
        lines.push('', c.bold(where[origin] ?? origin));
        for (const s of list) lines.push(`  ${s.name.padEnd(22)} ${c.dim(s.description.slice(0, 90))}`);
      }
      return { output: lines.join('\n') };
    }
    case 'hooks': {
      const h = agent.hooks;
      const sources = h?.allSources ?? [];
      if (!sources.length) return { output: `No hooks configured. baton runs Claude Code-format hooks from ~/.claude/settings.json, baton's config ("hooks"), and (once trusted) this project's .claude/settings.json.` };
      const lines: string[] = [];
      for (const s of sources) {
        const off = s.project && !h?.isTrusted;
        lines.push(`${off ? c.yellow('○') : c.green('●')} ${c.bold(s.label)}${off ? c.yellow('  off until you /trust this folder') : ''}`);
        for (const [event, groups] of Object.entries(s.hooks)) {
          for (const g of groups ?? []) for (const cmd of g.hooks) lines.push(`    ${event}${g.matcher ? ` [${g.matcher}]` : ''}  ${c.dim(cmd.command.slice(0, 100))}`);
        }
      }
      return { output: lines.join('\n') };
    }
    case 'trust': {
      const h = agent.hooks;
      if (!h) return { output: 'Hooks are not available here.' };
      const off = arg === 'off';
      h.setTrusted(!off);
      return { output: off ? "This folder is no longer trusted; its project hooks won't run." : `Trusted this folder: its project hooks (${h.allSources.filter((s) => s.project).map((s) => s.label).join(', ') || 'none yet'}) will run. Undo with /trust off.` };
    }
    case 'memory': {
      const files = loadInstructions(agent.session.cwd);
      if (!files.length) return { output: `No instruction files found. ${c.bold('/init')} writes an AGENTS.md for this project.` };
      return {
        output: [
          'Every model in the chain follows these (later ones take precedence):',
          ...files.map((f) => `  ${c.green('●')} ${f.label}  ${c.dim(`${f.content.length.toLocaleString()} chars`)}`),
          c.dim('Edit the files directly; changes apply from the next request.'),
        ].join('\n'),
      };
    }
    case 'mcp': {
      const servers = agent.mcp?.servers ?? [];
      if (!servers.length) return { output: `No MCP servers configured. Outside baton, run ${c.bold('baton mcp import')} or ${c.bold('baton mcp add')}.` };
      const lines = servers.map((s) => {
        const status =
          s.status === 'connected' ? c.green(`connected · ${s.tools.length} tools`)
          : s.status === 'connecting' ? c.dim('connecting…')
          : s.status === 'needs-login' ? c.yellow(`needs sign-in: run baton mcp login ${s.name}`)
          : s.status === 'disabled' ? c.dim('disabled')
          : c.red(`failed: ${s.error ?? ''}`);
        const tools = s.status === 'connected' ? `\n    ${c.dim(s.tools.map((t) => t.name).join(', ').slice(0, 300))}` : '';
        return `${s.status === 'connected' ? c.green('●') : c.yellow('●')} ${c.bold(s.name)}  ${status}${tools}`;
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
