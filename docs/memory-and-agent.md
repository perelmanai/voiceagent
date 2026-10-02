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

The agent **is Claude Code**, dispatched programmatically through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The dashboard doesn't run its own model loop anymore — it hands the task to Claude Code, which brings its own agent loop, context management (automatic compaction), retry handling, and web tools, then it maps Claude Code's message stream back onto the run/step UI.

### Browser control (`lib/mcp.ts`)

Claude Code drives the browser through the same `@playwright/mcp` server as before — navigate, snapshot, click, type, fill forms, select, scroll, tabs, file upload, screenshots. Real browser control, not URL construction. `lib/mcp.ts` is now just the config builder: it produces the stdio server entry the Agent SDK passes to Claude Code, which spawns and owns the process (one per run).

- **Headed by default** so the user watches the work happen. `AGENT_HEADLESS=1` hides it.
- Persistent profile at `data/browser-profile/`, so logins survive across runs.
- Browser auto-detection: system Chrome → Edge → Playwright's bundled Chromium (found by scanning the ms-playwright cache and passing `--executable-path`, since Playwright MCP otherwise defaults to the Chrome channel). Override with `AGENT_BROWSER`.

### The dispatch (`lib/agent.ts`)

One `query()` call per run, max 50 turns / 10 minutes:

1. Recall memory for the task and build the prompt (today's date + memory block + task).
2. Dispatch Claude Code with a locked-down surface: built-in tools limited to `WebSearch` + `WebFetch` (no shell, no filesystem), the Playwright MCP server, and an **in-process MCP server** exposing `recall_memory` / `save_memory` straight into the SQLite memory store. With the surface restricted, permission prompts are bypassed so the run is fully autonomous.
3. Stream Claude Code's messages into steps: assistant text → *thought*, `tool_use` → *tool*, tool results → *observation*, the `result` message → *final* (or a mapped error for turn-limit / execution failures). A wall-clock timer aborts the run at the deadline; the stop button aborts it immediately.

`settingSources: []` keeps the machine's Claude Code settings and CLAUDE.md files out of the run, and `persistSession: false` keeps runs stateless — the dashboard's own SQLite tables are the history. Auth comes from the machine's Claude Code login (no API key needed); `CLAUDE_AGENT_MODEL` overrides the model.

Every step is written to `agent_steps` and pushed to subscribers, so `/api/agent/stream` (SSE) can replay a run from the beginning and then follow it live — reload the page mid-run and the trace is intact.

What used to be hand-rolled robustness code is now Claude Code's job: history compaction, rate-limit retries, and output truncation all happen inside the harness. If the browser MCP fails to connect, the init message reports it and the run continues search-only.

### Safety

The system prompt forbids entering payment details, passwords, or verification codes, and forbids completing a purchase. The agent drives the flow to the last safe step — flight selected, cart ready, checkout open — then stops and explains how to finish. On top of the prompt, the tool surface itself is restricted: Claude Code gets no Bash, no file tools, no subagents — only the browser, web search/fetch, and the memory server. One run at a time (`isAgentBusy`), and any run can be stopped from the UI.

### Web search

Claude Code's built-in `WebSearch` / `WebFetch` tools. `lib/search.ts` (Gemini-grounded search with a DuckDuckGo fallback) is no longer used by the agent and only remains in the tree as a utility.

---

## 3. UI

The right rail's three mock panels (People / Events / Tasks — hardcoded fake data) are replaced by three live ones:

- **Suggestions** — now includes a sixth kind, `agent`. When the model detects a multi-step *intent* rather than a lookup, the card carries a `task` string and its button dispatches the agent instead of opening a link.
- **Agent** — free-text task input, live step feed over SSE, stop button, result, and recent run history.
- **Memory** — everything the agent knows, searchable, with type/category/age, a reinforcement counter, per-item delete, and an accent highlight on memories recalled for the current suggestion round.

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
| `lib/agent.ts` | Claude Code dispatch via the Agent SDK, memory MCP server, run registry, SSE events |
| `api/memory/route.ts` | GET list/search · POST add · DELETE |
| `api/agent/route.ts` | POST start · GET runs · DELETE stop |
| `api/agent/stream/route.ts` | SSE replay + live step stream |
| `api/analyze/route.ts` | Memory-aware suggestions; triggers extraction via `after()` |
| `components/memory-panel.tsx` | Memory UI |
| `components/agent-panel.tsx` | Agent UI |

## Notes on models

**Gemini** (suggestions + memory): model **aliases** (`gemini-flash-latest`, `gemini-flash-lite-latest`) are used rather than pinned point versions — `gemini-2.5-flash` was already returning 404 "no longer available to new users" for new keys during development. Override via `GEMINI_FAST_MODEL` / `GEMINI_EMBEDDING_MODEL`. A paid key still matters for the live suggestion loop.

**Claude Code** (the agent): runs on whatever model the machine's Claude Code defaults to, billed to that login's subscription — no per-step Gemini quota pressure anymore. Override with `CLAUDE_AGENT_MODEL` (e.g. `claude-opus-5`), and point `CLAUDE_CODE_PATH` at an installed `claude` binary if the SDK's bundled one can't read the login.
