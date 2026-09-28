import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Target } from '../router/router.js';

export interface ProviderConfig {
  /** Wire protocol. "openai" covers OpenAI, OpenRouter, LiteLLM, Ollama, vLLM... */
  type: 'anthropic' | 'openai';
  apiKey?: string;
  /** Name of the env var holding the key (preferred over inline apiKey). */
  apiKeyEnv?: string;
  baseURL?: string;
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  headers?: Record<string, string>;
}

export interface TargetConfig {
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type ApprovalMode = 'ask' | 'auto-edit' | 'yolo';

export interface Config {
  providers: Record<string, ProviderConfig>;
  /** Failover order. The first entry is the starting model. */
  chain: TargetConfig[];
  approval?: ApprovalMode;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT = 16_000;

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
 * Zero-config fallback: build a chain from whichever API keys are present.
 * Order mirrors the motivating use case (OpenAI first, fall back to Claude).
 * Model ids are overridable via env because they go stale fast.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const providers: Config['providers'] = {};
  const chain: TargetConfig[] = [];

  if (env.OPENAI_API_KEY) {
    providers.openai = { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' };
    chain.push({ provider: 'openai', model: env.BATON_OPENAI_MODEL ?? 'gpt-5', contextWindow: 272_000 });
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.anthropic = { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' };
    chain.push({ provider: 'anthropic', model: env.BATON_ANTHROPIC_MODEL ?? 'claude-sonnet-5', contextWindow: 200_000 });
  }
  if (env.OPENROUTER_API_KEY && env.BATON_OPENROUTER_MODEL) {
    providers.openrouter = { type: 'openai', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' };
    chain.push({ provider: 'openrouter', model: env.BATON_OPENROUTER_MODEL });
  }
  if (env.BATON_OLLAMA_MODEL) {
    providers.ollama = { type: 'openai', baseURL: env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1', apiKey: 'ollama' };
    chain.push({ provider: 'ollama', model: env.BATON_OLLAMA_MODEL, contextWindow: 32_000, maxOutputTokens: 4_096 });
  }
  return { providers, chain };
}

export function toTargets(config: Config): Target[] {
  return config.chain.map((t) => ({
    provider: t.provider,
    model: t.model,
    contextWindow: t.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: t.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
  }));
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
    if (p.type !== 'anthropic' && p.type !== 'openai') fail(`provider "${name}" has unknown type "${String(p.type)}"`);
  }
  for (const t of config.chain) {
    if (!config.providers[t.provider]) fail(`chain entry references unknown provider "${t.provider}"`);
    if (!t.model) fail(`chain entry for "${t.provider}" is missing "model"`);
  }
}
