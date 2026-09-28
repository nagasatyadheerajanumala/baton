import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConfig } from './config.js';
import { codexHome } from './config.js';

/** A model an account can run, for the /model picker. */
export interface ModelInfo {
  id: string;
  description: string;
  contextWindow: number;
}

/** Claude lineup (platform.claude.com model overview, 2026-09-28). Same ids on the plan and the API. */
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-fable-5-1', description: 'deepest reasoning, long agentic work', contextWindow: 1_000_000 },
  { id: 'claude-opus-5-5', description: 'long-running coding and knowledge work', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5-5', description: 'fast, strong all-rounder', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', description: 'fastest, lightweight tasks', contextWindow: 200_000 },
];

/** OpenAI API lineup (developers.openai.com models, 2026-09-28). */
export const OPENAI_API_MODELS: ModelInfo[] = [
  { id: 'gpt-6-astra', description: 'most capable', contextWindow: 922_000 },
  { id: 'gpt-6-sol', description: 'coding and agentic work', contextWindow: 922_000 },
  { id: 'gpt-6-luna', description: 'fast and cheap', contextWindow: 922_000 },
];

/** Fallback when Codex's own model cache isn't available. */
const CODEX_FALLBACK: ModelInfo[] = [
  { id: 'gpt-6-astra', description: 'frontier intelligence for demanding work', contextWindow: 272_000 },
  { id: 'gpt-6-sol', description: 'workhorse for coding and everyday work', contextWindow: 272_000 },
  { id: 'gpt-6-luna', description: 'fast, for easier tasks', contextWindow: 272_000 },
];

interface CodexCacheModel {
  slug?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  context_window?: number;
}

/**
 * Models the user's ChatGPT plan offers, from the list Codex itself caches
 * (~/.codex/models_cache.json). That's the same list Codex's /model shows,
 * including real context windows. Not a credential file.
 */
export function codexModels(env: NodeJS.ProcessEnv = process.env): ModelInfo[] {
  try {
    const raw = JSON.parse(readFileSync(join(codexHome(env), 'models_cache.json'), 'utf8')) as { models?: CodexCacheModel[] };
    const models = (raw.models ?? [])
      .filter((m) => m.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({
        id: m.slug!,
        description: (m.description ?? '').replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()),
        contextWindow: m.context_window ?? 272_000,
      }));
    return models.length ? models : CODEX_FALLBACK;
  } catch {
    return CODEX_FALLBACK;
  }
}

/** Every model the account behind `provider` can run. Unknown gateways list only what's configured. */
export function modelCatalog(provider: ProviderConfig, env: NodeJS.ProcessEnv = process.env): ModelInfo[] {
  switch (provider.type) {
    case 'codex':
      return codexModels(env);
    case 'claude-code':
    case 'anthropic':
      return CLAUDE_MODELS;
    case 'openai':
      return OPENAI_API_MODELS;
    default:
      return [];
  }
}

/** Context window for a model on an account, if the catalog knows it. */
export function knownContextWindow(provider: ProviderConfig, model: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  return modelCatalog(provider, env).find((m) => m.id === model)?.contextWindow;
}
