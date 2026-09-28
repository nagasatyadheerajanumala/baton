import { compact } from '../../compaction/compact.js';
import { isHumanTurnStart } from '../../ir/session.js';
import { type Message, isText } from '../../ir/types.js';

const RESULT_CAP = 2_000;

/**
 * Render IR history as a plain-text transcript. Agent CLIs can't accept
 * another model's raw tool calls, so a handoff into one passes the history
 * as text (compacted to a budget) and asks it to continue.
 */
export function renderTranscript(messages: Message[], budgetTokens = 40_000): string {
  const view = compact(messages, { budgetTokens, keepRecentTurns: 3, toolOutputCap: RESULT_CAP }).messages;
  const out: string[] = [];
  for (const m of view) {
    for (const b of m.content) {
      if (b.type === 'text') {
        const who = m.role === 'user' ? 'User' : `Assistant${m.meta.model ? ` (${m.meta.model})` : ''}`;
        out.push(`${who}: ${b.text.trim()}`);
      } else if (b.type === 'tool_call') {
        out.push(`[tool call] ${b.name} ${JSON.stringify(b.input)}`);
      } else if (b.type === 'tool_result') {
        const body = b.content.length > RESULT_CAP ? `${b.content.slice(0, RESULT_CAP)}\n[... truncated]` : b.content;
        out.push(`[tool result${b.isError ? ', error' : ''}]\n${body}`);
      }
    }
  }
  return out.join('\n\n');
}

/**
 * The prompt for one external turn. `unseen` are messages this CLI session
 * hasn't seen (all of them for a fresh session). The last human message is
 * the request; everything before it is context.
 */
export function buildExternalPrompt(unseen: Message[], freshSession: boolean): string {
  const lastHumanIdx = unseen.map(isHumanTurnStart).lastIndexOf(true);
  const last = unseen[unseen.length - 1];
  const endsOnRequest = lastHumanIdx === unseen.length - 1;
  const request = endsOnRequest ? last!.content.filter(isText).map((b) => b.text).join('\n') : undefined;
  const context = endsOnRequest ? unseen.slice(0, -1) : unseen;

  const parts: string[] = [];
  if (context.length) {
    parts.push(
      freshSession
        ? 'You are taking over a coding session from another model. Here is the conversation so far; tool calls in it were really executed and their results are genuine:'
        : 'While you were away, another model continued this session. Here is what happened; tool calls in it were really executed:',
      '<transcript>',
      renderTranscript(context),
      '</transcript>',
    );
  }
  parts.push(request ?? 'Continue the task from exactly where the transcript leaves off. Do not redo work that is already done.');
  return parts.join('\n\n');
}
