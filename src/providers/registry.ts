import { type Config, resolveApiKey } from '../config/config.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import type { ProviderAdapter } from './types.js';

/** Instantiate one adapter per configured provider that the chain uses. */
export function buildAdapters(config: Config, env: NodeJS.ProcessEnv = process.env): Map<string, ProviderAdapter> {
  const used = new Set(config.chain.map((t) => t.provider));
  const adapters = new Map<string, ProviderAdapter>();
  for (const name of used) {
    const p = config.providers[name]!;
    const apiKey = resolveApiKey(p, env);
    adapters.set(
      name,
      p.type === 'anthropic'
        ? new AnthropicAdapter({ name, apiKey, baseURL: p.baseURL })
        : new OpenAIAdapter({ name, apiKey, baseURL: p.baseURL, maxTokensParam: p.maxTokensParam, headers: p.headers }),
    );
  }
  return adapters;
}
