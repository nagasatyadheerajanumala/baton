import type { AssistantTurn, ContentBlock } from '../src/ir/types.js';
import type { CompletionRequest, ProviderAdapter } from '../src/providers/types.js';

type Step = AssistantTurn | Error | ((req: CompletionRequest) => AssistantTurn);

/** Provider that plays back a fixed script and records every request it saw. */
export class ScriptedAdapter implements ProviderAdapter {
  readonly requests: CompletionRequest[] = [];
  constructor(
    readonly name: string,
    private readonly steps: Step[],
  ) {}

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    this.requests.push(structuredClone({ ...req, onText: undefined, signal: undefined, bridge: undefined }));
    const step = this.steps.shift();
    if (!step) throw new Error(`${this.name}: script exhausted`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : step;
  }
}

export const text = (t: string): AssistantTurn => ({ content: [{ type: 'text', text: t }], stopReason: 'end_turn' });

export const toolCall = (id: string, name: string, input: Record<string, unknown>, preamble?: string): AssistantTurn => ({
  content: [
    ...(preamble ? ([{ type: 'text', text: preamble }] as ContentBlock[]) : []),
    { type: 'tool_call', id, name, input },
  ],
  stopReason: 'tool_use',
});

/** Shaped like the SDKs' APIError: status, headers, message, error body. */
export function apiError(status: number, message: string, body?: unknown, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), { status, headers: new Headers(headers), error: body });
}

export const quotaError = () =>
  apiError(429, '429 You exceeded your current quota, please check your plan and billing details.', {
    error: { type: 'insufficient_quota', code: 'insufficient_quota' },
  });
