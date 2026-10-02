# Memory & Agentic Actions

Two systems added on top of the live-transcript co-pilot:

1. **Memory** — the app builds a durable, searchable model of the user from what they say, and feeds it back into everything it does.
2. **Agent** — an autonomous loop with a real Chrome browser and web search that carries out multi-step tasks ("book a flight", "find a restaurant").

Both are server-side, live in `dashboard/src/lib/`, and persist to SQLite at `dashboard/data/aural.db` (gitignored, created on first run).

---

## 1. Memory

### Storage (`lib/db.ts`)

`better-sqlite3` in WAL mode. Three concerns, three tables:

| Table | Purpose |
|---|---|
| `memories` | One durable fact per row, plus its embedding and strength metadata |
| `memories_fts` | FTS5 index over content/entities/category, kept in sync by triggers |
| `agent_runs` / `agent_steps` | Agent run history and its step-by-step trace |

A memory row carries more than text: `type` (preference / fact / person / place / plan / interest), `category` (food, travel, work…), `entities[]`, the `source_text` it came from, a 768-dim `embedding` blob, plus `salience`, `reinforcements`, `access_count`, and timestamps. Those last four are what make recall behave like memory rather than like a database query.

### Writing memories (`lib/memory.ts` → `extractAndStore`)

Runs on every analyzed utterance, but **after** the HTTP response is sent (Next.js `after()` in `/api/analyze`), so it never adds latency to the live suggestion loop.

1. **Extract** — Gemini reads the transcript window against a prompt that defines what "durable" means. It writes each fact as a canonical third-person sentence ("User loves deep dish pizza from Lou Malnati's"), assigns a type/category/entities, converts relative dates to absolute, and scores salience 0–1. Small talk and one-off trivia are explicitly excluded; returning nothing is a valid answer.
2. **Embed** — candidates are embedded with `gemini-embedding-001` (`RETRIEVAL_DOCUMENT`, 768-dim, L2-normalized).
3. **Consolidate** — each candidate is compared against every stored embedding:
   - **cosine ≥ 0.87** → the same fact resurfacing. Reinforce the existing row (`reinforcements + 1`, salience raised to the max of the two). No duplicate written.
   - **0.62 ≤ cosine < 0.87** → related but possibly distinct. One cheap LLM call decides `new` / `duplicate` / `update`. `update` rewrites the stored content and re-embeds, so "User is moving to Austin" supersedes "User lives in SF" instead of both sitting in the database contradicting each other.
   - **below 0.62** → genuinely new; insert.

   If the judge call fails or skips a candidate, it is stored anyway — a near-duplicate is a better failure than lost information.

### Reading memories (`recall`)

Hybrid retrieval, four weighted channels:

```
score = 0.55·cosine + 0.20·keyword(bm25) + 0.15·recency + 0.10·strength
```

- **Vector** — cosine similarity against a `RETRIEVAL_QUERY` embedding of the query (query embeddings are LRU-cached; the embedding matrix is cached in-process and invalidated on write).
- **Keyword** — FTS5 bm25 rank, normalized. Catches exact names that embeddings sometimes smooth over.
- **Recency** — `exp(-ageDays / 45)`, so stale facts fade without being deleted.
- **Strength** — `0.6·salience + 0.4·min(1, reinforcements/5)`. Repeatedly-mentioned facts outrank passing ones.

Results below 0.3 are dropped. **If embeddings are unavailable the vector weight is removed and the remaining three renormalize**, so recall degrades instead of failing. Every returned memory has `access_count` incremented.

### Where memory is used

- **`/api/analyze`** injects a recalled block into the suggestion prompt, and returns the recalled IDs so the UI can highlight them. This is what turns "maybe I'll order a pizza" into a Lou Malnati's suggestion.
- **The agent** loads memory into its system context at run start, and can call `recall_memory` / `save_memory` mid-task.
- **`/api/memory`** backs the Memory panel: list, full-text search, manual add, delete.

---

## 2. Agentic actions

Actions can run with **Codex** through the official Codex SDK or **Claude Code** through the Claude Agent SDK. Codex is the default; the Agent panel remembers a user's provider selection. Both providers share the run registry, browser configuration, memory context, cancellation controls, and streamed history. Each stored run records its provider; existing rows migrate to `claude`.

### Browser control (`lib/mcp.ts`)

Both providers drive the browser through `@playwright/mcp`: navigate, snapshot, click, type, fill forms, select, scroll, tabs, and screenshots. `lib/mcp.ts` produces the stdio server configuration used for each run.

- **Headed by default** so the user watches the work happen. `AGENT_HEADLESS=1` hides it.
- Persistent profile at `data/browser-profile/`, so logins survive across runs.
- Browser auto-detection: system Chrome → Edge → Playwright's bundled Chromium (found by scanning the ms-playwright cache and passing `--executable-path`, since Playwright MCP otherwise defaults to the Chrome channel). Override with `AGENT_BROWSER`.

### The dispatch (`lib/agent.ts`)

Runs have a 10-minute deadline and share a single browser lock:

1. Recall memory for the task and build the prompt (today's date + memory block + task).
2. Dispatch the chosen provider with browser tools, web search, and memory access. Codex runs in an isolated working directory with shell tools disabled and a read-only sandbox. Claude's built-in tools are limited to `WebSearch` and `WebFetch`, with a 50-turn limit.
3. Map provider events to the shared step format: messages, tool calls, observations, final results, and errors. A wall-clock timer aborts the run at the deadline; the stop button cancels the current run.

Authentication uses the selected provider's local login or explicitly configured API key. The app does not copy login tokens into its database or send them to the browser. See `dashboard/.env.example` for model and executable overrides.

Every step is written to `agent_steps` and pushed to subscribers, so `/api/agent/stream` (SSE) can replay a run from the beginning and then follow it live.

### Safety

The shared system prompt forbids entering payment details, passwords, or verification codes, and forbids completing a purchase. The agent drives the flow to the last safe step—flight selected, cart ready, checkout open—then stops and explains how to finish. Both providers restrict their tool surface to the needs of browser actions. Only one run can execute at a time (`isAgentBusy`), and any run can be stopped from the UI.

### Web search

Codex uses its web search capability; Claude uses `WebSearch` / `WebFetch`. `lib/search.ts` remains a separate utility.

---

## 3. UI

The right rail's three mock panels (People / Events / Tasks — hardcoded fake data) are replaced by three live ones:

- **Suggestions** — now includes a sixth kind, `agent`. When the model detects a multi-step *intent* rather than a lookup, the card carries a `task` string and its button dispatches the agent instead of opening a link.
- **Agent** — Codex/Claude selector, free-text task input, live step feed over SSE, stop button, result, and recent run history with provider labels.
- **Memory** — everything the agent knows, searchable, with type/category/age, a reinforcement counter, per-item delete, and an accent highlight on memories recalled for the current suggestion round.

### Conversation timing

Browser recognition and Android `activity` / `partial` / `final` / `end` / `stop` events feed the same `SpeechConversation` buffer. Stable utterance IDs let final results replace partial text and let retries be ignored. A recognizer's final result is only a stable audio chunk: it does not automatically finish the conversation turn.

Completed, punctuated speech settles after 1.8 seconds of quiet; unpunctuated speech gets 3.5 seconds. Clearly unfinished English clauses stay open for their continuation, even if recognition added a premature period. Speech activity suspends the timer. Explicit Stop preserves the last partial and flushes it. This uses conservative text heuristics, so sentence completion is not a semantic guarantee for every language or phrasing.

Consecutive turns from the same speaker appear in readable blocks. Suggestions are analyzed from the assembled text, and resumed speech cancels stale responses. Older Android clients that send only `{code, text}` still work; install the updated Android app to stream partial text and activity too.

---

## Files

| File | Role |
|---|---|
| `lib/db.ts` | SQLite schema, FTS5 triggers, cached handle |
| `lib/genai.ts` | Shared Gemini client (suggestions + memory), model aliases, quota/retry helpers |
| `lib/embeddings.ts` | Document/query embeddings, cosine, blob conversion, LRU cache |
| `lib/memory.ts` | Extraction, consolidation, hybrid recall, CRUD |
| `lib/mcp.ts` | Playwright MCP server config (browser detection, profile, flags) |
| `lib/search.ts` | Grounded web search + DuckDuckGo fallback (unused by the agent) |
| `lib/agent.ts` | Provider dispatch, memory MCP server, run registry, SSE events |
| `lib/codex-agent.ts` / `lib/codex-events.ts` | Codex SDK execution and event mapping |
| `lib/codex-memory.ts` | Authenticated, per-run memory MCP bridge on loopback |
| `lib/speech-conversation.ts` / `lib/speech-protocol.ts` | Shared turn assembly and phone event validation |
| `api/memory/route.ts` | GET list/search · POST add · DELETE |
| `api/agent/route.ts` | POST start · GET runs · DELETE stop |
| `api/agent/stream/route.ts` | SSE replay + live step stream |
| `api/analyze/route.ts` | Memory-aware suggestions; triggers extraction via `after()` |
| `components/memory-panel.tsx` | Memory UI |
| `components/agent-panel.tsx` | Agent UI |

## Notes on models

**Codex** (default action provider): uses the local Codex login, or `CODEX_API_KEY` / `OPENAI_API_KEY` when configured. `CODEX_AGENT_MODEL` selects a model and `CODEX_PATH` selects a local executable. See the [official SDK documentation](https://learn.chatgpt.com/docs/codex-sdk).

**Gemini** (suggestions + memory): model **aliases** (`gemini-flash-latest`, `gemini-flash-lite-latest`) are used rather than pinned point versions — `gemini-2.5-flash` was already returning 404 "no longer available to new users" for new keys during development. Override via `GEMINI_FAST_MODEL` / `GEMINI_EMBEDDING_MODEL`. A paid key still matters for the live suggestion loop.

**Claude Code** (the agent): runs on whatever model the machine's Claude Code defaults to, billed to that login's subscription — no per-step Gemini quota pressure anymore. Override with `CLAUDE_AGENT_MODEL` (e.g. `claude-opus-5`), and point `CLAUDE_CODE_PATH` at an installed `claude` binary if the SDK's bundled one can't read the login.
