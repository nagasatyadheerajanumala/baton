import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { type Config, type ProviderConfig, detectSubscriptions, isSubscriptionType, resolveApiKey, toTargets } from './config/config.js';
import { Session, newMessage } from './ir/session.js';
import { ToolBridge } from './mcp/bridge.js';
import { ProcessManager } from './tools/processes.js';
import { ToolEngine } from './tools/registry.js';
import type { Tool } from './tools/types.js';
import { type Message, type ToolSpec, isReasoning, isText, isToolCall } from './ir/types.js';
import { buildAdapters, keyEnvName } from './providers/registry.js';
import type { ProviderAdapter } from './providers/types.js';
import { classifyError } from './router/errors.js';
import { type Target, targetLabel } from './router/router.js';

/**
 * `baton doctor`: prove each chain entry works *for baton*, not just that a
 * key exists. Per target it runs a real two-step tool loop (model calls a
 * tool, gets the result, answers), which exercises auth, billing, the model
 * id, streaming, tool calling and reasoning replay. Costs a fraction of a cent.
 */

export const PROVIDER_HELP: Record<string, { keys: string; billing: string; env: string }> = {
  openai: {
    keys: 'https://platform.openai.com/api-keys',
    billing: 'https://platform.openai.com/account/billing/overview',
    env: 'OPENAI_API_KEY',
  },
  anthropic: {
    keys: 'https://platform.claude.com/settings/keys',
    billing: 'https://platform.claude.com/settings/billing',
    env: 'ANTHROPIC_API_KEY',
  },
  openrouter: { keys: 'https://openrouter.ai/settings/keys', billing: 'https://openrouter.ai/settings/credits', env: 'OPENROUTER_API_KEY' },
};

const SUBSCRIPTION_NOTE =
  'API usage is billed separately from ChatGPT Plus/Pro and Claude Pro/Max subscriptions; a subscription does not include API credits.';

const ECHO_TOOL: ToolSpec = {
  name: 'echo',
  description: 'Echo the given text back. Used for a connectivity check.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

const SUBSCRIPTION_HELP = {
  'claude-code': {
    label: 'Claude Code',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login   (sign in with your Claude Pro/Max account; or run `claude` and type /login)',
  },
  codex: {
    label: 'Codex',
    install: 'npm install -g @openai/codex   (or: brew install codex)',
    login: 'codex login   (choose "Sign in with ChatGPT")',
  },
} as const;

const echoTool: Tool = {
  spec: ECHO_TOOL,
  mutates: false,
  describe: (i) => `echo ${String(i.text ?? '')}`,
  execute: async (i) => ({ content: String(i.text ?? '') }),
};

export interface CheckResult {
  target: string;
  ok: boolean;
  lines: string[];
}

type Out = (s: string) => void;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export async function runDoctor(config: Config, source: string, out: Out = (s) => process.stdout.write(s + '\n'), env = process.env): Promise<number> {
  out(`config: ${source}`);
  if (config.chain.length === 0) {
    out(red('No models configured.'));
    out('Set OPENAI_API_KEY and/or ANTHROPIC_API_KEY, or create baton.config.json (see docs/SETUP.md).');
    return 1;
  }
  out(`chain:  ${config.chain.map((t) => `${t.provider}/${t.model}`).join(' → ')}\n`);

  const adapters = buildAdapters(config, env);
  const results: CheckResult[] = [];
  for (const target of toTargets(config)) {
    const provider = config.providers[target.provider]!;
    const r = await checkTarget(target, provider, adapters.get(target.provider)!, env);
    results.push(r);
    out(`${r.ok ? green('✓') : red('✗')} ${targetLabel(target)}`);
    for (const l of r.lines) out(`    ${l}`);
  }

  const usable = results.filter((r) => r.ok).length;
  out('');
  if (usable === results.length) out(green(`All ${usable} models ready. Failover covers the whole chain.`));
  else if (usable > 0) out(yellow(`${usable} of ${results.length} models ready. Failover will skip the others until fixed.`));
  else out(red('No model is usable yet. Fix the items above, then run `baton doctor` again.'));
  return usable === results.length ? 0 : 1;
}

async function checkTarget(
  target: Target,
  provider: ProviderConfig,
  adapter: ProviderAdapter,
  env: NodeJS.ProcessEnv,
): Promise<CheckResult> {
  const label = targetLabel(target);
  if (isSubscriptionType(provider.type)) return checkSubscription(target, provider, adapter, env);
  const help = PROVIDER_HELP[target.provider];
  const key = resolveApiKey(provider, env);

  if (!key && provider.type !== 'openai-compatible') {
    const envName = keyEnvName(target.provider, provider);
    return {
      target: label,
      ok: false,
      lines: [
        red(`no API key: ${envName} is not set`),
        ...(help ? [`create one: ${help.keys}`] : []),
        `then: export ${envName}=...   (add it to ~/.zshrc to persist)`,
      ],
    };
  }

  const started = Date.now();
  const system = 'You are running a connectivity check for a coding tool. Follow the instructions exactly.';
  const history: Message[] = [
    newMessage('user', [{ type: 'text', text: 'Call the echo tool with text "baton". After you receive the result, reply with only the word OK.' }]),
  ];
  const req = (messages: Message[]) => ({ model: target.model, system, messages, tools: [ECHO_TOOL], maxTokens: 2_048 });

  try {
    const first = await adapter.complete(req(history));
    const calls = first.content.filter(isToolCall);
    const reasoning = first.content.filter(isReasoning).length;
    const lines: string[] = [];

    if (calls.length === 0) {
      const said = first.content.filter(isText).map((b) => b.text).join(' ').slice(0, 80);
      return {
        target: label,
        ok: false,
        lines: [yellow(`key and model work, but the model did not call the tool (said: "${said}")`), 'baton needs tool calling; pick a model that supports it.'],
      };
    }

    history.push(newMessage('assistant', first.content));
    history.push(newMessage('user', calls.map((c) => ({ type: 'tool_result' as const, callId: c.id, content: String(c.input.text ?? '') }))));
    const second = await adapter.complete(req(history));
    const answer = second.content.filter(isText).map((b) => b.text).join(' ').trim();

    const ms = Date.now() - started;
    const tokens = (first.usage?.inputTokens ?? 0) + (first.usage?.outputTokens ?? 0) + (second.usage?.inputTokens ?? 0) + (second.usage?.outputTokens ?? 0);
    lines.push(dim(`auth ok · tool call ok · follow-up ok (${ms} ms, ${tokens} tokens)`));
    if (reasoning) lines.push(dim(`reasoning: ${reasoning} block(s) replayed to the model across the tool call`));
    if (!/\bok\b/i.test(answer)) lines.push(yellow(`unexpected final answer: "${answer.slice(0, 80)}" (connectivity is fine)`));
    return { target: label, ok: true, lines };
  } catch (err) {
    return { target: label, ok: false, lines: await explain(err, target, provider, key) };
  }
}

/** Subscription CLIs: installed? signed in? then one real turn where the model calls a baton tool over MCP. */
async function checkSubscription(target: Target, provider: ProviderConfig, adapter: ProviderAdapter, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = targetLabel(target);
  const kind = provider.type as 'claude-code' | 'codex';
  const help = SUBSCRIPTION_HELP[kind];
  const status = detectSubscriptions(env)[kind === 'claude-code' ? 'claude' : 'codex'];
  if (!status.installed) return { target: label, ok: false, lines: [red(`${help.label} CLI isn't installed.`), `install: ${help.install}`, `then sign in: ${help.login}`] };
  if (!status.loggedIn) return { target: label, ok: false, lines: [red(`${help.label} isn't signed in.`), `run: ${help.login}`, dim('baton never sees your login; the official CLI handles it.')] };

  const bridge = new ToolBridge(new ToolEngine([echoTool]));
  const session = new Session(undefined, process.cwd(), { persist: false });
  const started = Date.now();
  try {
    bridge.attach({
      session,
      events: {},
      ctx: { cwd: process.cwd(), approve: async () => true, processes: new ProcessManager() },
      producer: () => ({ provider: target.provider, model: target.model }),
    });
    const ask = session.push(newMessage('user', [{ type: 'text', text: 'Call the echo tool with text "baton". After you receive the result, reply with only the word OK.' }]));
    const turn = await adapter.complete({
      model: target.model,
      system: 'You are running a connectivity check for a coding tool. Follow the instructions exactly.',
      messages: [ask],
      tools: [ECHO_TOOL],
      maxTokens: 2_048,
      bridge,
    });
    const usedTool = session.messages.some((m) => m.content.some((b) => b.type === 'tool_call' && b.name === 'echo'));
    const answer = turn.content.filter(isText).map((b) => b.text).join(' ').trim();
    const lines = [dim(`signed in · ${usedTool ? "baton's tools reachable over MCP" : 'no tool call'} · answered (${Date.now() - started} ms) · billed to your plan`)];
    if (!usedTool) lines.push(yellow("The model answered without calling baton's tools; edits and commands may not work through this provider."));
    if (!/\bok\b/i.test(answer)) lines.push(yellow(`unexpected final answer: "${answer.slice(0, 80)}"`));
    return { target: label, ok: usedTool, lines };
  } catch (err) {
    const why = classifyError(err);
    const msg = dim(why.message.split('\n')[0]!.slice(0, 200));
    if (why.kind === 'auth') return { target: label, ok: false, lines: [red(`${help.label} isn't signed in (or the session expired).`), msg, `run: ${help.login}`] };
    if (why.kind === 'quota') return { target: label, ok: false, lines: [yellow(`Your plan's usage limit is reached right now; baton will skip this provider until it resets.`), msg] };
    if (why.kind === 'model_not_found') return { target: label, ok: false, lines: [red(`Model "${target.model}" isn't available on your plan.`), msg] };
    return { target: label, ok: false, lines: [red(`${help.label} request failed.`), msg] };
  } finally {
    bridge.detach();
    await bridge.stop();
  }
}

async function explain(err: unknown, target: Target, provider: ProviderConfig, key: string | undefined): Promise<string[]> {
  const why = classifyError(err);
  const help = PROVIDER_HELP[target.provider];
  const msg = dim(why.message.split('\n')[0]!.slice(0, 200));
  switch (why.kind) {
    case 'auth':
      return [red('API key rejected (401/403).'), msg, ...(help ? [`check or create a key: ${help.keys}`] : [])];
    case 'quota':
      return [red('No API credits / quota exhausted.'), msg, ...(help ? [`add credits: ${help.billing}`] : []), SUBSCRIPTION_NOTE];
    case 'model_not_found': {
      const models = await listModels(provider, key).catch(() => []);
      const family = target.model.split(/[-/:]/)[0] ?? '';
      const suggestions = models.filter((m) => m.startsWith(family)).slice(0, 8);
      return [
        red(`Model "${target.model}" not available to this key.`),
        msg,
        suggestions.length ? `available: ${suggestions.join(', ')}` : 'update "model" in your config (see the provider\'s model list)',
      ];
    }
    case 'network':
      return [red(`Could not reach ${provider.baseURL ?? 'the provider'}.`), msg, ...(provider.baseURL?.includes('11434') ? ['is Ollama running? start it with: ollama serve'] : [])];
    case 'rate_limit':
    case 'overloaded':
      return [yellow(`Provider temporarily unavailable (${why.kind}); your key is probably fine. Try again shortly.`), msg];
    default:
      return [red(`Request failed (${why.status ?? 'no status'}).`), msg];
  }
}

export async function listModels(provider: ProviderConfig, apiKey: string | undefined): Promise<string[]> {
  const ids: string[] = [];
  if (provider.type === 'anthropic') {
    const client = new Anthropic({ apiKey, baseURL: provider.baseURL, maxRetries: 0 });
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
  } else {
    const client = new OpenAI({ apiKey: apiKey ?? 'unused', baseURL: provider.baseURL, maxRetries: 0 });
    for await (const m of client.models.list()) ids.push(m.id);
  }
  return ids.sort();
}
