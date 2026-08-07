# AI subsystem

This guide elaborates on `AGENTS.md`. If anything here conflicts with `AGENTS.md`, `AGENTS.md` wins.

## Overview

The AI subsystem is BYOK (bring your own key). It supports cloud providers via `@ai-sdk/*` and local / offline providers via OpenAI-compatible endpoints. The agent layer is built on Vercel AI SDK v6 chat semantics: `streamText`, tool definitions, and `stopWhen` step limits.

Main entry point: `runAgentStream` in `src/modules/ai/lib/agent.ts`.

## Providers

Cloud providers are defined in `src/modules/ai/config.ts`:

- OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter
- `openai-compatible` for any custom base URL
- Local: LM Studio, MLX, Ollama

`buildLanguageModel` in `src/modules/ai/lib/agent.ts:76` branches on `provider` to construct the correct AI SDK provider instance. Local providers use `createOpenAICompatible` with a `localProxyFetch` that allows private-network access, while cloud providers use their dedicated SDK constructors.

Model metadata (context limits, costs, reasoning behavior) lives in the model registry in `config.ts`. `resolveModel` maps a model id to its provider and defaults.

### Adding a new provider

1. Add a `ProviderInfo` entry to `PROVIDERS` in `src/modules/ai/config.ts`.
2. Add model ids and metadata to the model registry in the same file.
3. Add a branch in `buildLanguageModel` (`src/modules/ai/lib/agent.ts:99`) that constructs the provider instance. For OpenAI-compatible APIs you can often reuse `createOpenAICompatible`.
4. If the provider requires an API key, update `providerNeedsKey` in `config.ts` and the keyring service mapping.
5. If it needs a dedicated `@ai-sdk/*` package, add it to `package.json` and justify the bundle cost (see `CONTRIBUTING.md`).
6. New built-ins must justify unique value beyond `openai-compatible` and OpenRouter; `CONTRIBUTING.md` calls this out explicitly.

Keys are never persisted outside the OS keychain / Linux secrets file.

## Agent run loop

`runAgentStream` (`agent.ts:391`):

1. Resolves the model via `buildConfiguredLanguageModel`.
2. Builds a stable system prompt from `selectSystemPrompt(modelId)`, the session working directory, optional persona, custom instructions, and `AGENTS.md` project instructions. Before contacting the model, the exact prompt and any new user message are committed to disk.
3. Converts UI messages to model messages, prunes reasoning content if the model does not keep it, and compacts old messages if the context limit is exceeded.
4. Streams via `streamText` with the tool set from `buildTools(ctx)` and `stopWhen: stepCountIs(MAX_AGENT_STEPS)`.
5. Emits step labels, usage deltas, and finish metadata.

The tool set is assembled in `src/modules/ai/tools/tools.ts` from `fs`, `edit`, `search`, `shell`, `subagent`, `terminal`, `todo`, and `managedAgent` builders.

## Sub-agents

`src/modules/ai/agents/registry.ts` defines read-only sub-agents: `explore`, `code-review`, `security`, and `general`. Each has a whitelist of tools and its own system prompt. `run_subagent` cannot recurse (the subagent tool set excludes `run_subagent` itself).

## Sessions

Conversations are organized into sessions. Accepted user messages and completed response records are stored as one atomic JSONL file per UUID under `~/.terax/sessions/` (`src-tauri/src/modules/ai_sessions.rs`, `src/modules/ai/lib/sessions.ts`, and `src/modules/ai/lib/sessionMessages.ts`):

- `<uuid>.jsonl`: the first line is a fixed metadata record; each remaining line is one role message
- `<uuid>.lock`: OS lock used while one process is running the session
- no shared session index; list operations read only the first metadata line
- `ai_sessions_list` projects each header to an explicit lightweight summary and never returns inspection-only metadata such as `systemPrompt`

```json
{"_type":"metadata","key":"<uuid>","createdAt":"2026-07-26T10:00:00.000Z","updatedAt":"2026-07-26T10:00:01.000Z","environmentKey":"local","cwd":"/workspace/project","metadata":{"title":"Session title","todos":[],"systemPrompt":"..."}}
```

The JSONL message schema belongs to Terax rather than Vercel AI SDK. User and assistant text use direct `role` and `content` fields, reasoning uses `reasoning_content`, and tool results use `role: "tool"`. Tool calls deliberately follow the OpenAI-compatible envelope:

```json
{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"README.md\"}"}}],"timestamp":"2026-07-26T10:00:00.000Z"}
{"role":"tool","tool_call_id":"call_1","name":"read_file","content":{"content":"..."},"timestamp":"2026-07-26T10:00:00.000Z"}
```

`function.arguments` is always a JSON string. Explicit adapters project these records into AI SDK `UIMessage` values when a chat is hydrated. Each persistence phase sends only its new records to Rust; Rust reads the existing JSONL under the session lock, appends them, and atomically replaces the complete file. This keeps the disk format readable and makes a future SDK switch local to the adapter.

Streaming state remains in the owning process. Sending first acquires the session run lock; while the active session holds it, new/switch/delete actions are disabled so its runtime bridge cannot be unmounted. The transport commits accepted user records and the current prompt before creating the model request. `AgentRunBridge` appends only complete Assistant and tool records after the run becomes idle, errors, or is stopped and no approval is pending. The observable frontend lock is cleared only after both the terminal commit and Rust lock release succeed. Focus/poll/normal-close paths also flush completed runs. A crash retains the latest accepted user message without writing a partial Assistant stream.

Other Workspace processes poll metadata every three seconds (paused while hidden with the AI panel closed), refresh on focus, and never overwrite a locally running session. Fingerprint changes evict inactive cached runtimes before reuse. The active session id is stored in the UUID-specific Workspace file and restores the saved id, then the most recent session file, then a fresh session.

## Composer

`AiComposerProvider` (`src/modules/ai/lib/composer.tsx`) is a React context that holds shared input state (text, attachments, voice) for the docked input bar and any other surface. Attachments can be images, text files, or `selection` chips from the terminal or editor. Selections are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit time and are not pasted into the textarea.

The composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.

A draft displays and follows the current Explorer root. Its first accepted user message promotes it to a persisted session and freezes that root as `cwd`. Persisted sessions always display and use their stored `cwd`. Files and selections are sent only when explicitly attached, as visible user-message content.

Each model request first commits its new user message and the exact current system prompt under the session run lock. Approval continuations overwrite only the prompt and do not duplicate the user record. Once the run reaches idle, error, or stop, the bridge appends the complete Assistant and tool records with the same turn ID. Streaming fragments are never written.

## Tools and approval

Tool definitions live under `src/modules/ai/tools/`:

- Read-only tools (`read_file`, `list_directory`, `grep`, `glob`) auto-execute after passing the security deny-list.
- Mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`, `bash_run`, `bash_background`) set `needsApproval: true`. The AI SDK pauses and the UI renders an approval card.
- `edit` / `multi_edit` enforce a read-before-edit invariant: the model must have read the file earlier in the session.
- In plan mode, mutating tools queue edits for batch review instead of applying them immediately.

Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`.

## Edit diffs

AI-proposed file edits open in an `ai-diff` tab. The user accepts or rejects per hunk. Only after acceptance does the `write_file` or `edit` tool actually run. This keeps the approval UI decoupled from the tool execution.

## Live context bridge

`App.tsx` publishes the current Explorer root for unsent drafts and a lazy terminal-buffer reader. Once a draft is sent, the session's stored `cwd` becomes the sole base for relative tool paths. Terminal output remains live and is read only when the model explicitly calls the terminal tool.

## Invariants

- Keep the Vercel AI SDK v6 chat shape (`streamText`, tools, step limits); the rest of the UI depends on it.
- Keys only via `secrets_*` commands; never disk, settings store, or `localStorage`.
- New providers must justify their bundle cost and unique value.
- Mutating tools require approval; read-only tools still pass the deny-list.
- The in-memory message list, persisted message records, and model input preserve the same message content. No active tab, cwd, or environment block is injected during send.
- A persisted session's `cwd` is immutable and every relative tool path resolves against it.
- Acquiring a persisted session run restores the saved cwd authorization from the validated JSONL header without changing the Explorer root.
- A session run lock owns its in-memory runtime until commit and release both succeed; session navigation must not bypass that lifecycle.

## See also

- [`AGENTS.md`](../../AGENTS.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [Security model](security-model.md) - the boundaries every tool must respect
