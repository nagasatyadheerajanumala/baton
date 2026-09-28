import { type CompactResult, compact, estimateTextTokens } from '../compaction/compact.js';
import { type Session, newMessage, touchedFiles } from '../ir/session.js';
import { type ToolCallBlock, type ToolResultBlock, isToolCall } from '../ir/types.js';
import { ToolBridge } from '../mcp/bridge.js';
import type { McpManager } from '../mcp/client.js';
import type { Classified } from '../router/errors.js';
import { type Router, type Target, targetLabel } from '../router/router.js';
import { gitSnapshot } from '../tools/shell.js';
import { ProcessManager, formatDuration } from '../tools/processes.js';
import type { ToolEngine } from '../tools/registry.js';
import { instructionsPrompt, loadInstructions } from './instructions.js';
import { buildSystemPrompt } from './prompt.js';

export interface AgentEvents {
  onText?: (delta: string) => void;
  onToolStart?: (call: ToolCallBlock, description: string) => void;
  onToolEnd?: (call: ToolCallBlock, result: ToolResultBlock) => void;
  onRetry?: (target: Target, waitMs: number, why: Classified) => void;
  onSwitch?: (from: Target, to: Target, why: Classified) => void;
  onCompact?: (target: Target, result: CompactResult) => void;
  onNotice?: (message: string) => void;
}

export interface AgentOptions {
  cwd: string;
  approve: (summary: string, call?: ToolCallBlock) => Promise<boolean>;
  /** Shared with the UI; a private one is created if omitted. */
  processes?: ProcessManager;
  /** MCP servers; their tools are added to the tool engine as they connect. */
  mcp?: McpManager;
  /** True while the user has plan mode on. */
  planMode?: () => boolean;
  /** Hard stop on runaway tool loops. */
  maxSteps?: number;
}

/** Fraction of (window - output reserve) we allow ourselves to fill. */
const SAFETY = 0.9;

export class Agent {
  readonly processes: ProcessManager;
  /** MCP server for agent CLIs (Claude Code / Codex); only created if the chain has one. */
  readonly bridge: ToolBridge | undefined;

  constructor(
    readonly session: Session,
    readonly router: Router,
    readonly tools: ToolEngine,
    private readonly opts: AgentOptions,
  ) {
    this.processes = opts.processes ?? new ProcessManager();
    if (router.chain.some((t) => router.adapter(t).external)) this.bridge = new ToolBridge(tools);
    const mcp = opts.mcp;
    if (mcp) {
      tools.setMcpTools(mcp.tools());
      mcp.on('change', () => tools.setMcpTools(mcp.tools()));
    }
  }

  get mcp(): McpManager | undefined {
    return this.opts.mcp;
  }

  /** Stop the MCP bridge and disconnect MCP servers. */
  async close(): Promise<void> {
    await this.bridge?.stop();
    await this.opts.mcp?.close();
  }

  /** Run one human turn to completion: model -> tools -> model ... -> final answer. */
  async run(userText: string, events: AgentEvents = {}, signal?: AbortSignal): Promise<void> {
    this.session.push(newMessage('user', [{ type: 'text', text: userText }]));
    const maxSteps = this.opts.maxSteps ?? 50;
    // Agent CLIs run their own loop and call baton's tools through the bridge;
    // it records each step into this session as it happens.
    this.bridge?.attach({
      session: this.session,
      events,
      ctx: { cwd: this.opts.cwd, signal, approve: this.opts.approve, processes: this.processes, planMode: this.opts.planMode },
      producer: () => ({ provider: this.router.current.provider, model: this.router.current.model }),
    });
    try {
      await this.loop(maxSteps, events, signal);
    } finally {
      this.bridge?.detach();
    }
  }

  private async loop(maxSteps: number, events: AgentEvents, signal?: AbortSignal): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
      const { turn, target } = await this.router.complete(
        (t, scale) => this.prepare(t, scale, events),
        {
          onRetry: events.onRetry,
          onSwitch: (from, to, why) => {
            this.session.recordSwitch({ from: targetLabel(from), to: targetLabel(to), reason: why.kind, ts: Date.now() });
            events.onSwitch?.(from, to, why);
          },
        },
        signal,
      );

      // Only complete turns reach the log (see invariants in ir/types.ts).
      const external = this.router.adapter(target).external === true;
      this.session.push(
        newMessage('assistant', turn.content, {
          provider: target.provider,
          model: target.model,
          usage: turn.usage,
          ...(external ? { subscription: true } : {}),
        }),
      );

      const calls = turn.content.filter(isToolCall);
      if (calls.length === 0) {
        if (turn.stopReason === 'max_tokens') events.onNotice?.('Response hit the output token limit.');
        return;
      }

      const results: ToolResultBlock[] = [];
      for (const call of calls) {
        if (signal?.aborted) {
          // Still answer every call, or the history becomes invalid for all providers.
          results.push({ type: 'tool_result', callId: call.id, content: 'Skipped: interrupted by the user.', isError: true });
          continue;
        }
        events.onToolStart?.(call, this.tools.describe(call));
        const result = await this.tools.run(call, { cwd: this.opts.cwd, signal, approve: this.opts.approve, processes: this.processes, planMode: this.opts.planMode });
        events.onToolEnd?.(call, result);
        results.push(result);
      }
      this.session.push(newMessage('user', results));
      if (signal?.aborted) return;
    }
    events.onNotice?.(`Stopped after ${maxSteps} steps without a final answer. Send a message to continue.`);
  }

  /** Build a request sized for `target`, compacting the history view if needed. */
  private async prepare(target: Target, budgetScale: number, events: AgentEvents) {
    const plan = this.opts.planMode?.()
      ? '\n\n# Plan mode is ON\nDo not change anything: no file edits, no commands with side effects. Research with read-only tools, then reply with a concise, numbered implementation plan (files to touch, what changes, how you will verify) and stop. The user will approve before you implement.'
      : '';
    const system = buildSystemPrompt(this.opts.cwd) + instructionsPrompt(loadInstructions(this.opts.cwd)) + plan + (await this.handoffNote(target));
    const toolTokens = estimateTextTokens(JSON.stringify(this.tools.specs));
    const budget = Math.floor(
      ((target.contextWindow - target.maxOutputTokens) * SAFETY - estimateTextTokens(system) - toolTokens) * budgetScale,
    );
    const view = compact(this.session.messages, { budgetTokens: Math.max(budget, 1_000) });
    if (view.applied.length) events.onCompact?.(target, view);
    return {
      model: target.model,
      system,
      messages: view.messages,
      tools: this.tools.specs,
      maxTokens: target.maxOutputTokens,
      onText: events.onText,
      bridge: this.bridge,
    };
  }

  /**
   * When the model about to answer differs from whoever produced earlier
   * assistant turns, tell it so, and give it fresh ground truth (git state,
   * touched files) instead of trusting its reading of someone else's history.
   */
  private async handoffNote(target: Target): Promise<string> {
    const prior = this.session.messages.filter((m) => m.role === 'assistant' && m.meta.provider);
    const others = [...new Set(prior.map((m) => `${m.meta.provider}/${m.meta.model}`))].filter((l) => l !== targetLabel(target));
    if (others.length === 0) return '';

    const last = prior[prior.length - 1];
    const justSwitched = last !== undefined && `${last.meta.provider}/${last.meta.model}` !== targetLabel(target);
    const lines = [
      '',
      '# Session handoff',
      `Earlier assistant turns in this conversation were produced by: ${others.join(', ')}. ` +
        `You (${targetLabel(target)}) are continuing the same session. All tool calls shown were really executed ` +
        'locally and their results are genuine. Continue the task seamlessly; do not restart or re-plan from scratch.',
    ];
    if (justSwitched) {
      const files = touchedFiles(this.session.messages);
      if (files.length) lines.push('', 'Files modified so far this session:', ...files.map((f) => `- ${f}`));
      lines.push('', 'Current git state (fresh, taken just now):', '```', await gitSnapshot(this.opts.cwd), '```');
      const bg = this.processes.list().filter((p) => p.running);
      if (bg.length) {
        lines.push('', 'Background processes still running (started earlier in this session; use process_output / process_kill):');
        for (const p of bg) lines.push(`- #${p.info.id} \`${p.info.command}\` (running ${formatDuration(Date.now() - p.info.startedAt)})`);
      }
    }
    return lines.join('\n');
  }
}
