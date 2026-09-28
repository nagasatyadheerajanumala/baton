import type { Message, Usage } from './ir/types.js';

/** USD per 1M tokens. */
export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Standard (non-batch) list prices, checked against provider docs 2026-09-28.
 * Only an estimate: excludes cache-write surcharges, long-context tiers and
 * regional pricing. Override per chain entry with `pricing` in config.
 */
export const PRICES: Record<string, Price> = {
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'claude-fable-5-1': { input: 10, cachedInput: 0.25, output: 50 },
  'claude-opus-5-5': { input: 4, cachedInput: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cachedInput: 0.2, output: 10 },
  'claude-haiku-4-5': { input: 1, cachedInput: 0.1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, cachedInput: 0.1, output: 5 },
};

/** Look up by exact id, then without a gateway prefix ("anthropic/claude-sonnet-5-5"). */
export function priceFor(model: string, override?: Price): Price | undefined {
  return override ?? PRICES[model] ?? PRICES[model.split('/').pop() ?? ''];
}

export function usageCost(usage: Usage, price: Price): number {
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  return ((usage.inputTokens - cached) * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1_000_000;
}

export interface SessionCost {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** True if some turns used a model with no known price (usd then undercounts). */
  partial: boolean;
}

export function sessionCost(messages: Message[], overrides: Record<string, Price | undefined> = {}): SessionCost {
  const total: SessionCost = { usd: 0, inputTokens: 0, outputTokens: 0, partial: false };
  for (const m of messages) {
    const u = m.meta.usage;
    if (!u) continue;
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    const price = m.meta.model ? priceFor(m.meta.model, overrides[m.meta.model]) : undefined;
    if (price) total.usd += usageCost(u, price);
    else total.partial = true;
  }
  return total;
}
