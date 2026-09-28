import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Price } from '../pricing.js';
import { codexModels, modelCatalog } from './models.js';
import type { Target } from '../router/router.js';

export interface ProviderConfig {
  /**
   * Wire protocol:
   *  - "anthropic"          Anthropic Messages API
   *  - "openai"             OpenAI Responses API (api.openai.com)
   *  - "openai-compatible"  Chat Completions: OpenRouter, LiteLLM, Ollama, vLLM...
   *  - "claude-code"        the official Claude Code CLI, signed in with your Claude Pro/Max plan
   *  - "codex"              the official Codex CLI, signed in with your ChatGPT plan
   */
  type: 'anthropic' | 'openai' | 'openai-compatible' | 'claude-code' | 'codex';
  /** claude-code / codex: path to the CLI binary (default: found on PATH). */
  command?: string;
  /** Display name in the UI, e.g. "Work API key". Defaults to the account type ("Claude plan"). */
  label?: string;
  apiKey?: string;
  /** Name of the env var holding the key (preferred over inline apiKey). */
  apiKeyEnv?: string;
  baseURL?: string;
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  headers?: Record<string, string>;
  /** "openai" only: reasoning.effort (none|low|medium|high|xhigh|max). */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface TargetConfig {
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** USD per 1M tokens, for the cost estimate. Built-in prices cover current OpenAI/Claude models. */
  pricing?: Price;
}

export type ApprovalMode = 'ask' | 'auto-edit' | 'yolo';

export interface Config {
  providers: Record<string, ProviderConfig>;
  /** Failover order. The first entry is the starting model. */
  chain: TargetConfig[];
  approval?: ApprovalMode;
}

export const PROVIDER_TYPES: ProviderConfig['type'][] = ['anthropic', 'openai', 'openai-compatible', 'claude-code', 'codex'];
export const isSubscriptionType = (t: ProviderConfig['type']) => t === 'claude-code' || t === 'codex';

export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Reasoning tokens count against this on current models, so leave headroom. */
export const DEFAULT_MAX_OUTPUT = 32_000;

/** Current defaults, checked against provider docs 2026-09-28. Override via config or env. */
export const DEFAULT_MODELS = {
  openai: { model: 'gpt-6-sol', contextWindow: 922_000 }, // 922k max input, 128k max output
  anthropic: { model: 'claude-sonnet-5-5', contextWindow: 1_000_000 }, // 128k max output
} as const;

export const configPaths = (cwd: string) => [
  join(cwd, 'baton.config.json'),
  join(process.env.BATON_HOME ?? join(homedir(), '.baton'), 'config.json'),
];

/** Project config wins over user config; no merging, to keep behavior obvious. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): { config: Config; source: string } {
  for (const p of configPaths(cwd)) {
    if (existsSync(p)) {
      const config = JSON.parse(readFileSync(p, 'utf8')) as Config;
      validate(config, p);
      return { config, source: p };
    }
  }
  return { config: configFromEnv(env), source: 'environment (no config file found)' };
}

/**
 * Zero-config fallback: build a chain from signed-in subscription CLIs first
 * (already paid for), then whichever API keys are present as overflow.
 * Model ids are overridable via env because they go stale fast.
 */
export function configFromEnv(env: NodeJS.ProcessEnv, subs: Subscriptions = detectSubscriptions(env)): Config {
  const providers: Config['providers'] = {};
  const chain: TargetConfig[] = [];
  addSubscriptions(providers, chain, subs);

  if (env.OPENAI_API_KEY) {
    providers.openai = { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' };
    chain.push({ provider: 'openai', model: env.BATON_OPENAI_MODEL ?? DEFAULT_MODELS.openai.model, contextWindow: DEFAULT_MODELS.openai.contextWindow });
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.anthropic = { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' };
    chain.push({ provider: 'anthropic', model: env.BATON_ANTHROPIC_MODEL ?? DEFAULT_MODELS.anthropic.model, contextWindow: DEFAULT_MODELS.anthropic.contextWindow });
  }
  if (env.OPENROUTER_API_KEY && env.BATON_OPENROUTER_MODEL) {
    providers.openrouter = { type: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' };
    chain.push({ provider: 'openrouter', model: env.BATON_OPENROUTER_MODEL });
  }
  if (env.BATON_OLLAMA_MODEL) {
    providers.ollama = { type: 'openai-compatible', baseURL: env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1', apiKey: 'ollama' };
    chain.push({ provider: 'ollama', model: env.BATON_OLLAMA_MODEL, contextWindow: 32_000, maxOutputTokens: 4_096 });
  }
  return { providers, chain };
}

export function toTargets(config: Config, env: NodeJS.ProcessEnv = process.env): Target[] {
  return config.chain.map((t) => {
    const provider = config.providers[t.provider]!;
    const models = modelCatalog(provider, env);
    const known = models.find((m) => m.id === t.model)?.contextWindow;
    // Plans run through their CLI, whose window is fixed; for APIs an explicit config value wins.
    const contextWindow = isSubscriptionType(provider.type) ? known ?? t.contextWindow : t.contextWindow ?? known;
    return {
      provider: t.provider,
      model: t.model,
      contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: t.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      ...(t.pricing ? { pricing: t.pricing } : {}),
      models: models.length ? models : [{ id: t.model, description: '', contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW }],
    };
  });
}

/** Remember a model choice as the account's default in the config file baton loaded. */
export function saveModelChoice(configFile: string, provider: string, model: string): boolean {
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Config;
    const entry = config.chain.find((t) => t.provider === provider);
    if (!entry) return false;
    entry.model = model;
    delete entry.contextWindow; // derived from the model catalog from now on
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

export function resolveApiKey(p: ProviderConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined) ?? p.apiKey;
}

function validate(config: Config, path: string): void {
  const fail = (msg: string) => {
    throw new Error(`Invalid config ${path}: ${msg}`);
  };
  if (!config.providers || typeof config.providers !== 'object') fail('"providers" must be an object');
  if (!Array.isArray(config.chain) || config.chain.length === 0) fail('"chain" must be a non-empty array');
  for (const [name, p] of Object.entries(config.providers)) {
    if (!PROVIDER_TYPES.includes(p.type)) {
      fail(`provider "${name}" has unknown type "${String(p.type)}" (expected ${PROVIDER_TYPES.join(' | ')})`);
    }
    if (p.apiKey && (p.type === 'anthropic' || p.type === 'openai')) {
      process.emitWarning(`${path}: provider "${name}" has an inline apiKey; prefer "apiKeyEnv" so keys never land in a committed file.`);
    }
  }
  for (const t of config.chain) {
    if (!config.providers[t.provider]) fail(`chain entry references unknown provider "${t.provider}"`);
    if (!t.model) fail(`chain entry for "${t.provider}" is missing "model"`);
  }
}

/**
 * What `baton init` writes: signed-in subscriptions first, then API keys as
 * overflow. API entries are included only for keys that are set (or when
 * there's nothing else), so a subscription-only setup starts without warnings.
 */
export function starterConfig(subs: Subscriptions = detectSubscriptions(), env: NodeJS.ProcessEnv = process.env): Config {
  const providers: Config['providers'] = {};
  const chain: TargetConfig[] = [];
  addSubscriptions(providers, chain, subs);
  const none = chain.length === 0;
  if (env.OPENAI_API_KEY || none) {
    providers.openai = { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' };
    chain.push({ provider: 'openai', ...DEFAULT_MODELS.openai, maxOutputTokens: DEFAULT_MAX_OUTPUT });
  }
  if (env.ANTHROPIC_API_KEY || none) {
    providers.anthropic = { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' };
    chain.push({ provider: 'anthropic', ...DEFAULT_MODELS.anthropic, maxOutputTokens: DEFAULT_MAX_OUTPUT });
  }
  return { approval: 'ask', providers, chain };
}

// ---- Subscription CLIs --------------------------------------------------------------

export interface CliStatus {
  installed: boolean;
  loggedIn: boolean;
  /** Codex: the model set in ~/.codex/config.toml, if any. */
  defaultModel?: string;
}
export interface Subscriptions {
  claude: CliStatus;
  codex: CliStatus;
}

/** Run a CLI status command; `out` is stdout + stderr (codex prints its status on stderr). */
function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; installed: boolean; out: string } {
  const r = spawnSync(cmd, args, { env: env ?? process.env, timeout: 8_000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const installed = !(r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT');
  return { ok: r.status === 0, installed, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** Is each official CLI installed and signed in? Asks the CLIs; never reads their credentials. */
export function detectSubscriptions(env: NodeJS.ProcessEnv = process.env): Subscriptions {
  if (env.BATON_NO_SUBSCRIPTIONS) return { claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } };
  const claudeStatus = run('claude', ['auth', 'status'], env);
  const claudeLoggedIn = /"loggedIn"\s*:\s*true/.test(claudeStatus.out);
  const codexStatus = run('codex', ['login', 'status'], env);
  return {
    claude: { installed: claudeStatus.installed, loggedIn: claudeLoggedIn },
    codex: {
      installed: codexStatus.installed,
      loggedIn: codexStatus.ok && /logged in/i.test(codexStatus.out) && !/not logged in/i.test(codexStatus.out),
      defaultModel: codexDefaultModel(env),
    },
  };
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** Top-level `model = "..."` from Codex's config.toml (not its auth file). */
export function codexDefaultModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const toml = readFileSync(join(codexHome(env), 'config.toml'), 'utf8');
    const top = toml.split(/^\s*\[/m)[0] ?? '';
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  } catch {
    return undefined;
  }
}

function addSubscriptions(providers: Config['providers'], chain: TargetConfig[], subs: Subscriptions): void {
  if (subs.codex.loggedIn) {
    providers.chatgpt = { type: 'codex' };
    const model = subs.codex.defaultModel ?? codexModels()[0]?.id ?? DEFAULT_MODELS.openai.model;
    chain.push({ provider: 'chatgpt', model });
  }
  if (subs.claude.loggedIn) {
    providers.claude = { type: 'claude-code' };
    chain.push({ provider: 'claude', model: 'claude-opus-5-5' });
  }
}
