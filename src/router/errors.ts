/**
 * Classify raw SDK errors into failover decisions. Duck-typed on purpose:
 * Anthropic's and OpenAI's SDK error classes share a shape (status, headers,
 * error body) but no common base, and OpenAI-compatible servers (OpenRouter,
 * Ollama, LiteLLM) phrase the same failure a dozen different ways.
 */

export type FailureKind =
  | 'rate_limit' //   transient 429; worth a short wait on the same target
  | 'quota' //        exhausted quota/credits; this target is done for a while
  | 'overloaded' //   5xx / 529; provider-side trouble
  | 'context_length' // request too big for this model; compact and retry
  | 'auth' //         bad or missing key; never retry this target
  | 'network' //      could not reach the endpoint
  | 'aborted' //      user pressed Ctrl-C
  | 'fatal'; //       a bug or invalid request; surface it, don't mask it by failing over

export interface Classified {
  kind: FailureKind;
  retryAfterMs?: number;
  status?: number;
  message: string;
}

interface ErrorLike {
  name?: string;
  status?: number;
  code?: string;
  message?: string;
  headers?: Headers | Record<string, string>;
  error?: unknown;
  cause?: unknown;
}

const QUOTA_RE = /insufficient_quota|exceeded your current quota|credit balance|insufficient credits|billing|usage limit|quota exceeded|out of credits/i;
const CONTEXT_RE = /context.length|context_length_exceeded|prompt is too long|maximum context|too many tokens|request_too_large|input is too long|reduce the length/i;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyError(err: unknown): Classified {
  const e = (err ?? {}) as ErrorLike;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const text = [e.message, safeStringify(e.error)].filter(Boolean).join(' ');
  const base = { status, message: e.message ?? String(err) };

  if (e.name === 'AbortError' || e.name === 'APIUserAbortError') return { kind: 'aborted', ...base };

  if (status === undefined) {
    const code = e.code ?? (e.cause as ErrorLike | undefined)?.code;
    if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError' || (code && NETWORK_CODES.has(code))) {
      return { kind: 'network', ...base };
    }
    return { kind: 'fatal', ...base };
  }

  if (status === 401 || status === 403) return { kind: 'auth', ...base };
  if (status === 402) return { kind: 'quota', ...base }; // OpenRouter: out of credits
  if (status === 413 || CONTEXT_RE.test(text)) return { kind: 'context_length', ...base };
  if (QUOTA_RE.test(text)) return { kind: 'quota', retryAfterMs: retryAfter(e.headers), ...base };
  if (status === 429) return { kind: 'rate_limit', retryAfterMs: retryAfter(e.headers), ...base };
  if (status === 408 || status >= 500) return { kind: 'overloaded', retryAfterMs: retryAfter(e.headers), ...base };
  return { kind: 'fatal', ...base };
}

function retryAfter(headers: ErrorLike['headers']): number | undefined {
  const get = (k: string): string | undefined => {
    if (!headers) return undefined;
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(k) ?? undefined;
    return (headers as Record<string, string>)[k];
  };
  const ms = get('retry-after-ms');
  if (ms && !Number.isNaN(Number(ms))) return Number(ms);
  const s = get('retry-after');
  if (!s) return undefined;
  if (!Number.isNaN(Number(s))) return Number(s) * 1000;
  const date = Date.parse(s);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return '';
  }
}
