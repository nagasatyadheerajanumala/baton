import type { AssistantTurn } from '../ir/types.js';
import type { ModelInfo } from '../config/models.js';
import type { Price } from '../pricing.js';
import type { CompletionRequest, ProviderAdapter } from '../providers/types.js';
import { type Classified, classifyError } from './errors.js';

export interface Target {
  /** Adapter instance name from config ("anthropic", "openrouter", ...). */
  provider: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per 1M tokens; falls back to the built-in table in pricing.ts. */
  pricing?: Price;
  /** Every model this account can run (for the /model picker). */
  models?: ModelInfo[];
}

export const targetLabel = (t: Target) => `${t.provider}/${t.model}`;

export interface RouterHooks {
  onRetry?: (target: Target, waitMs: number, why: Classified) => void;
  onSwitch?: (from: Target, to: Target, why: Classified) => void;
  onCompactRetry?: (target: Target, budgetScale: number) => void;
}

/**
 * Builds the request for a given target. `budgetScale` < 1 means the previous
 * attempt overflowed the context window and the caller must compact harder.
 */
export type PrepareFn = (target: Target, budgetScale: number) => CompletionRequest | Promise<CompletionRequest>;

export class AllTargetsExhaustedError extends Error {
  constructor(
    readonly failures: { target: string; why: Classified }[],
    readonly nextAvailableAt: number | undefined,
  ) {
    const lines = failures.map((f) => `  ${f.target}: ${f.why.kind} (${f.why.message.slice(0, 120)})`);
    const when = nextAvailableAt ? ` Earliest retry: ${new Date(nextAvailableAt).toLocaleTimeString()}.` : '';
    super(`Every configured model is unavailable.${when}\n${lines.join('\n')}`);
  }
}

const COOLDOWN_MS: Record<'rate_limit' | 'quota' | 'overloaded' | 'network' | 'auth' | 'model_not_found', number> = {
  rate_limit: 60_000,
  quota: 60 * 60_000,
  overloaded: 30_000,
  network: 30_000,
  auth: Number.POSITIVE_INFINITY,
  model_not_found: Number.POSITIVE_INFINITY,
};

export interface RouterOptions {
  /** Wait on the same target only if the provider asks for less than this. */
  maxSameTargetWaitMs?: number;
  /** Retries on one target before failing over (rate_limit/overloaded/network). */
  sameTargetRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * Failover router. Sticky by design: after switching it stays on the new
 * target rather than bouncing back when the old one's cooldown ends, which
 * would thrash the prompt cache and confuse the conversation. Use
 * `setCurrent()` (the /model command) to switch back deliberately.
 */
export class Router {
  private currentIndex = 0;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly opts: Required<RouterOptions>;

  constructor(
    readonly chain: Target[],
    private readonly adapters: Map<string, ProviderAdapter>,
    opts: RouterOptions = {},
  ) {
    if (chain.length === 0) throw new Error('Router needs at least one target');
    for (const t of chain) {
      if (!adapters.has(t.provider)) throw new Error(`No adapter configured for provider "${t.provider}"`);
    }
    this.opts = {
      maxSameTargetWaitMs: opts.maxSameTargetWaitMs ?? 20_000,
      sameTargetRetries: opts.sameTargetRetries ?? 2,
      sleep: opts.sleep ?? abortableSleep,
      now: opts.now ?? Date.now,
    };
  }

  get current(): Target {
    return this.chain[this.currentIndex]!;
  }

  /** Switch the model an account uses (and make that account current). */
  setModel(index: number, model: string): Target {
    const t = this.chain[index];
    if (!t) throw new Error(`No chain entry ${index}`);
    const info = t.models?.find((m) => m.id === model);
    t.model = model;
    if (info) t.contextWindow = info.contextWindow;
    this.currentIndex = index;
    this.cooldownUntil.delete(targetLabel(t)); // explicit choice overrides cooldown
    return t;
  }

  adapter(t: Target): ProviderAdapter {
    return this.adapters.get(t.provider)!;
  }

  /** Manually pick a target by label, index, or unique substring. */
  setCurrent(query: string): Target {
    const i = /^\d+$/.test(query)
      ? Number(query)
      : this.chain.findIndex((t) => targetLabel(t) === query || t.model === query);
    const idx = i >= 0 ? i : this.chain.findIndex((t) => targetLabel(t).includes(query));
    if (idx < 0 || idx >= this.chain.length) throw new Error(`No target matches "${query}"`);
    this.currentIndex = idx;
    this.cooldownUntil.delete(targetLabel(this.current)); // explicit choice overrides cooldown
    return this.current;
  }

  cooldownRemaining(t: Target): number {
    const until = this.cooldownUntil.get(targetLabel(t));
    return until ? Math.max(0, until - this.opts.now()) : 0;
  }

  async complete(prepare: PrepareFn, hooks: RouterHooks = {}, signal?: AbortSignal): Promise<{ turn: AssistantTurn; target: Target }> {
    const failures: { target: string; why: Classified }[] = [];
    let budgetScale = 1;
    let retriesHere = 0;

    if (this.cooldownRemaining(this.current) > 0) {
      const next = this.nextAvailable();
      if (next === undefined) throw new AllTargetsExhaustedError(failures, this.earliestAvailable());
      this.currentIndex = next;
    }

    for (;;) {
      const target = this.current;
      const adapter = this.adapters.get(target.provider)!;
      try {
        const req = await prepare(target, budgetScale);
        const turn = await adapter.complete({ ...req, signal });
        return { turn, target };
      } catch (err) {
        const why = classifyError(err);
        if (why.kind === 'aborted' || why.kind === 'fatal') throw err;

        if (why.kind === 'context_length') {
          budgetScale *= 0.6;
          if (budgetScale < 0.1) throw err; // compaction can't save this request
          hooks.onCompactRetry?.(target, budgetScale);
          continue;
        }

        const canWaitHere =
          (why.kind === 'rate_limit' || why.kind === 'overloaded' || why.kind === 'network') &&
          retriesHere < this.opts.sameTargetRetries &&
          (why.retryAfterMs ?? 2_000 * 2 ** retriesHere) <= this.opts.maxSameTargetWaitMs;
        if (canWaitHere) {
          const wait = why.retryAfterMs ?? 2_000 * 2 ** retriesHere;
          retriesHere++;
          hooks.onRetry?.(target, wait, why);
          await this.opts.sleep(wait, signal);
          continue;
        }

        failures.push({ target: targetLabel(target), why });
        const cooldown = why.kind === 'quota' || why.kind === 'rate_limit'
          ? Math.max(why.retryAfterMs ?? 0, COOLDOWN_MS[why.kind])
          : COOLDOWN_MS[why.kind];
        this.cooldownUntil.set(targetLabel(target), this.opts.now() + cooldown);

        const next = this.nextAvailable();
        if (next === undefined) throw new AllTargetsExhaustedError(failures, this.earliestAvailable());
        this.currentIndex = next;
        retriesHere = 0;
        budgetScale = 1; // new model, new window: recompute from scratch
        hooks.onSwitch?.(target, this.current, why);
      }
    }
  }

  /** Next target after the current one in chain order, wrapping, skipping cooled-down ones. */
  private nextAvailable(): number | undefined {
    for (let step = 1; step <= this.chain.length; step++) {
      const i = (this.currentIndex + step) % this.chain.length;
      if (this.cooldownRemaining(this.chain[i]!) === 0) return i;
    }
    return undefined;
  }

  private earliestAvailable(): number | undefined {
    const finite = [...this.cooldownUntil.values()].filter(Number.isFinite);
    return finite.length ? Math.min(...finite) : undefined;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}
