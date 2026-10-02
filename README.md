# Aural Intel - Made by Interns Pranauv & Nandan
*note the name Aural Intel is temporary set for testing.



Real-time conversation co-pilot: speak into your phone, see a live transcript on the dashboard, and get Gemini-powered suggestion cards.

It also **remembers** and **acts**:

- **Long-term memory** — durable facts about you (places, foods, people, plans, preferences) are extracted from what you say and stored in SQLite with embeddings. Later conversations recall them automatically, so "maybe I'll order a pizza" becomes a suggestion for the deep-dish place you raved about last week.
- **Agentic actions** — the dashboard dispatches **Claude Code** (via the Claude Agent SDK) as the agent. It gets a real Chrome browser (via Playwright MCP), web search, and the memory store, and carries out multi-step tasks: book a flight, find a restaurant, compare products. You watch it work in a live step feed.

See [`docs/memory-and-agent.md`](docs/memory-and-agent.md) for the full architecture.

## Projects

| Directory | Description |
|-----------|-------------|
| `dashboard/` | Next.js web app (Aural Intel) |
| `android-voice/` | Android companion app (Aural Voice) |
| `docs/` | Design specs and architecture notes |

## Quick start

### Dashboard

```bash
cd dashboard
cp .env.example .env.local   # add your Gemini API key (suggestions + memory)
pnpm install
npx playwright install chromium   # only if you don't have Chrome/Edge installed
pnpm dev
```

The agent needs **Claude Code signed in on the machine**: install it and run `claude` once to log in. The dispatched agent uses that login — no Anthropic API key required.

Open http://localhost:3000 in Chrome.

The agent drives a **visible** browser window by default so you can watch it work. Set `AGENT_HEADLESS=1` to hide it, or `AGENT_BROWSER=msedge` to pick a different browser.

### Android app

1. Open `android-voice/` in Android Studio
2. Run on a physical device (same Wi-Fi as your Mac)
3. Scan the QR code on the dashboard, tap **Start mic**, and speak

See `android-voice/README.md` for full setup details.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | Suggestions and memory extraction + embeddings |
| `CLAUDE_AGENT_MODEL` | no | Model for the dispatched Claude Code agent (defaults to your Claude Code default) |
| `CLAUDE_CODE_PATH` | no | Path to an installed `claude` binary if the SDK's bundled one can't read your login |
| `AGENT_BROWSER` | no | `chrome` \| `msedge` \| `firefox` \| `webkit` (auto-detected) |
| `AGENT_HEADLESS` | no | `1` hides the agent's browser window |
| `GEMINI_FAST_MODEL` / `GEMINI_EMBEDDING_MODEL` | no | Gemini model overrides |

ANOTHER IMPORTANT NOTE (Nandan Found This):

Make sure you use a PAID GEMINI API Key, as a Free one will have rate limits and the analysis will not work as well as it would have otherwise.

(This now only affects the live suggestion loop and memory extraction — the agent runs on Claude Code, which uses your Claude subscription instead of the Gemini key.)

Local data lives in `dashboard/data/` (SQLite memory database + the agent's browser profile). It's gitignored — delete the folder to reset the agent's memory.

Never commit `.env.local` or other secret files.
