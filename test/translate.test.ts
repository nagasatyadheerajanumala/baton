import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { Message } from '../src/ir/types.js';
import { fromAnthropicContent, toAnthropicMessages } from '../src/providers/anthropic.js';
import { StreamAccumulator, toOpenAIMessages } from '../src/providers/openai.js';
import { fromResponse, toResponsesInput } from '../src/providers/openai-responses.js';
import { sanitizeToolId } from '../src/providers/types.js';

const m = (role: Message['role'], content: Message['content']): Message => ({ id: Math.random().toString(), role, content, meta: { ts: 0 } });

const history: Message[] = [
  m('user', [{ type: 'text', text: 'fix the bug' }]),
  m('assistant', [
    { type: 'text', text: 'Reading both files.' },
    { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    { type: 'tool_call', id: 'call_2', name: 'read_file', input: { path: 'b.ts' } },
  ]),
  m('user', [
    { type: 'tool_result', callId: 'call_1', content: 'A' },
    { type: 'tool_result', callId: 'call_2', content: 'ENOENT', isError: true },
  ]),
  m('assistant', [{ type: 'text', text: 'b.ts is missing.' }]),
];

describe('IR -> OpenAI', () => {
  it('splits tool results into tool messages and folds calls into tool_calls', () => {
    const out = toOpenAIMessages('SYS', history);
    expect(out.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
    const asst = out[2] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(asst.content).toBe('Reading both files.');
    expect(asst.tool_calls?.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect((asst.tool_calls?.[0] as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function.arguments).toBe('{"path":"a.ts"}');
    expect(out[4]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'ERROR: ENOENT' });
  });

  it('emits tool messages before user text when a user message mixes both', () => {
    const out = toOpenAIMessages('S', [
      history[1]!,
      m('user', [{ type: 'text', text: 'also check c.ts' }, { type: 'tool_result', callId: 'call_1', content: 'A' }, { type: 'tool_result', callId: 'call_2', content: 'B' }]),
    ]);
    expect(out.map((x) => x.role)).toEqual(['system', 'assistant', 'tool', 'tool', 'user']);
  });
});

describe('IR -> Anthropic', () => {
  it('maps tool calls/results and marks errors', () => {
    const out = toAnthropicMessages(history);
    expect(out.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const results = out[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(results[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_2', is_error: true });
  });

  it('merges consecutive same-role messages and puts tool results first', () => {
    const out = toAnthropicMessages([
      history[1]!,
      m('user', [{ type: 'text', text: 'hurry' }]),
      m('user', [{ type: 'tool_result', callId: 'call_1', content: 'A' }, { type: 'tool_result', callId: 'call_2', content: 'B' }]),
    ]);
    expect(out).toHaveLength(2);
    const types = (out[1]!.content as Anthropic.ContentBlockParam[]).map((b) => b.type);
    expect(types).toEqual(['tool_result', 'tool_result', 'text']);
  });

  it('drops empty text blocks, which Anthropic rejects', () => {
    const out = toAnthropicMessages([m('user', [{ type: 'text', text: 'hi' }]), m('assistant', [{ type: 'text', text: '  ' }, { type: 'tool_call', id: 'x', name: 'bash', input: {} }])]);
    expect((out[1]!.content as Anthropic.ContentBlockParam[]).map((b) => b.type)).toEqual(['tool_use']);
  });

  it('sets a cache breakpoint on the newest block only', () => {
    const out = toAnthropicMessages(history.slice(0, 3));
    const flat = out.flatMap((x) => x.content as Array<{ cache_control?: unknown }>);
    expect(flat.filter((b) => b.cache_control)).toHaveLength(1);
    expect(flat[flat.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('parses responses back into IR', () => {
    const ir = fromAnthropicContent([
      { type: 'text', text: 'ok', citations: null },
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' }, caller: { type: 'direct' } },
    ] as unknown as Anthropic.ContentBlock[]);
    expect(ir).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_call', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
    ]);
  });
});

describe('OpenAI stream reassembly', () => {
  const chunk = (delta: object, finish: string | null = null, usage?: object) =>
    ({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }], usage }) as unknown as OpenAI.Chat.ChatCompletionChunk;

  it('joins fragmented tool arguments across chunks and parallel calls', () => {
    const acc = new StreamAccumulator();
    acc.push(chunk({ content: 'Checking' }));
    acc.push(chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"pa' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'bash', arguments: '{"command":' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"x.ts"}' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 1, function: { arguments: '"ls"}' } }] }, 'tool_calls'));
    const turn = acc.finish();
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.content).toEqual([
      { type: 'text', text: 'Checking' },
      { type: 'tool_call', id: 'call_a', name: 'read_file', input: { path: 'x.ts' } },
      { type: 'tool_call', id: 'call_b', name: 'bash', input: { command: 'ls' } },
    ]);
  });

  it('flags unparseable arguments instead of throwing', () => {
    const acc = new StreamAccumulator();
    acc.push(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{"command": ls' } }] }, 'tool_calls'));
    expect(acc.finish().content[0]).toMatchObject({ input: { __unparsed_arguments: '{"command": ls' } });
  });
});

describe('sanitizeToolId', () => {
  it('is deterministic and satisfies the Anthropic id pattern', () => {
    expect(sanitizeToolId('call:abc/1.2')).toBe('call_abc_1_2');
    expect(sanitizeToolId('call:abc/1.2')).toBe(sanitizeToolId('call:abc/1.2'));
    expect(sanitizeToolId('')).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('reasoning blocks are model-bound', () => {
  const withReasoning: Message[] = [
    m('user', [{ type: 'text', text: 'go' }]),
    m('assistant', [
      { type: 'reasoning', origin: 'anthropic:claude-opus-5-5', data: { type: 'thinking', thinking: '', signature: 'S1' } },
      { type: 'tool_call', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
    ]),
    m('user', [{ type: 'tool_result', callId: 'toolu_1', content: 'a.ts' }]),
    m('assistant', [
      { type: 'reasoning', origin: 'openai-responses:gpt-6-sol', data: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'E1' } },
      { type: 'tool_call', id: 'call_2', name: 'read_file', input: { path: 'a.ts' } },
    ]),
    m('user', [{ type: 'tool_result', callId: 'call_2', content: '1\tx' }]),
  ];

  it('Anthropic replays thinking only to the model that produced it', () => {
    const same = JSON.stringify(toAnthropicMessages(withReasoning, 'claude-opus-5-5'));
    expect(same).toContain('"signature":"S1"');
    expect(same).not.toContain('E1');
    // Different Claude model: signatures are model-bound, so drop them.
    expect(JSON.stringify(toAnthropicMessages(withReasoning, 'claude-sonnet-5-5'))).not.toContain('S1');
  });

  it('Responses replays reasoning items only to the model that produced them, in order', () => {
    const items = toResponsesInput(withReasoning, 'gpt-6-sol') as unknown as Array<Record<string, unknown>>;
    expect(items.map((i) => i.type ?? `msg:${String(i.role)}`)).toEqual([
      'msg:user', 'function_call', 'function_call_output', 'reasoning', 'function_call', 'function_call_output',
    ]);
    expect(JSON.stringify(items)).not.toContain('S1');
    expect(JSON.stringify(toResponsesInput(withReasoning, 'gpt-6-luna'))).not.toContain('E1');
  });

  it('Chat Completions never sends reasoning blocks', () => {
    expect(JSON.stringify(toOpenAIMessages('s', withReasoning))).not.toMatch(/S1|E1/);
  });

  it('parses Responses output into IR, including reasoning and stop reasons', () => {
    const turn = fromResponse(
      {
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'E9' },
          { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] },
          { type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' },
        ],
        usage: { input_tokens: 5, output_tokens: 6 },
      } as unknown as OpenAI.Responses.Response,
      'gpt-6-sol',
    );
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
    expect(turn.content).toEqual([
      { type: 'reasoning', origin: 'openai-responses:gpt-6-sol', data: { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'E9' } },
      { type: 'text', text: 'Hi' },
      { type: 'tool_call', id: 'call_9', name: 'bash', input: { command: 'ls' } },
    ]);
    const truncated = fromResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } as unknown as OpenAI.Responses.Response);
    expect(truncated.stopReason).toBe('max_tokens');
  });
});
