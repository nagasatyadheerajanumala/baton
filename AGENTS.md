# baton

Coding-agent harness that hot-swaps LLM providers mid-session (e.g. OpenAI → Claude on quota exhaustion) while keeping conversation, tool state, and file changes intact.

## Commands

- `npm test` runs the vitest suite (unit, scripted e2e, and real-SDK wire tests against a local fake server; no API keys needed)
- `npm run typecheck`
- `npm run build` compiles to `dist/`; `npm run dev -- -p "prompt"` runs from source

## Architecture

```
src/
  ir/          types.ts: the IR (vendor-neutral messages); session.ts: JSONL log, settle(), derived views
  providers/   one adapter per wire protocol; ONLY place vendor formats exist
    anthropic.ts   Messages API (streaming, prompt caching)
    openai.ts      Chat Completions: covers OpenAI, OpenRouter, LiteLLM, Ollama via baseURL
  router/      errors.ts: SDK error -> FailureKind; router.ts: retry / compact / failover policy
  compaction/  deterministic, produces a *view*; never rewrites the session log
  tools/       vendor-agnostic tool engine (fs, search, bash, git_status) + approval gate
  agent/       loop.ts: model -> tools -> model; handoff note on provider switch
  ui/          readline REPL + terminal event printer
  config/      baton.config.json > ~/.baton/config.json > env-derived chain
```

## Invariants (don't break these)

1. **Only complete assistant turns are committed.** A stream that dies mid-response is discarded, so every provider switch happens on a settled boundary.
2. **Every `tool_call` gets exactly one `tool_result` in the next user message.** Even on abort/deny/crash; `settleMessages()` repairs logs, `repairPairing()` runs after compaction. Both Anthropic and OpenAI reject histories that violate this.
3. **Adapters throw raw SDK errors.** Classification lives in `router/errors.ts`; SDK `maxRetries` is 0 so the router owns all retry policy.
4. **Tool ids are kept verbatim in the IR** and sanitized deterministically on the way out (`sanitizeToolId`), so call/result pairs always agree.
5. **`fatal` errors are never masked by failover.** A malformed request would fail on every provider; surface it.
6. **The router is sticky.** After failover it stays on the new target; switching back is explicit (`/model`).

## Design decisions

- TypeScript/Node, official SDKs, minimal deps (no CLI framework; `node:util` parseArgs, `node:readline`).
- Chat Completions instead of the Responses API: one adapter serves four provider slots.
- Compaction is deterministic for now (stale reads → head/tail truncation → drop middle turns with a state summary). LLM summarization can slot in as a pass between truncation and drop, and must not run on the failover path itself.
- Subscription/OAuth auth (reusing Claude/ChatGPT plan logins) is **deliberately not implemented**; check provider terms before adding it. It would be an auth option on an existing adapter, not a new adapter.
