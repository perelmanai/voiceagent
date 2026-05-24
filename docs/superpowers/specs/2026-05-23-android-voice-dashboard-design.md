# Android Voice → Dashboard Live Transcription — Design

**Date:** 2026-05-23
**Status:** Approved (pending spec review)

## Summary

Build a simple native Android app (`android-voice/`) that captures speech via the
phone's microphone, transcribes it **on-device**, and pushes the transcript to the
existing Next.js dashboard in real time. The dashboard is modified to receive these
remote transcripts, display them, and run them through the existing Gemini
suggestion pipeline. The phone is the primary input device; the dashboard's own
browser mic remains available as a secondary source.

## Decisions (from brainstorming)

- **Transcription location:** On-device on Android (`SpeechRecognizer`). Mirrors how
  the dashboard already uses the browser's Web Speech API. No extra cloud STT cost.
- **Network model:** Internet-accessible. The dashboard runs locally (`next dev`) and
  is exposed via a tunnel (ngrok / cloudflared). The Android app targets a
  configurable base URL.
- **Input mode:** Phone is the primary input. The dashboard auto-listens for phone
  transcripts; the local browser mic button stays but is secondary.
- **Relay transport:** Server-Sent Events (SSE) + in-memory pub/sub (chosen over
  WebSockets and polling — one-way flow, real-time, minimal change to existing code).

## Architecture

```
[Android app]  --on-device SpeechRecognizer-->  final text lines
      |  POST /api/ingest { code, text }   (HTTPS via tunnel)
      v
[Next.js server]  --in-memory pub/sub keyed by pairing code-->
      |  SSE: GET /api/stream?code=...
      v
[Dashboard browser]  --merge lines into transcript-->  /api/analyze --> suggestion cards
```

### Pairing

The dashboard generates a short pairing code (e.g. `K7Q2`) on load and shows it in
the header. The phone enters the tunnel base URL + this code once. Both `/api/ingest`
and `/api/stream` are keyed by the code, so:

- Transcripts only reach the dashboard that holds the matching code.
- A public tunnel URL has basic isolation (a stranger needs the code to inject text).

The code is generated client-side, stored in React state, and passed as a query param
to the SSE stream and entered manually on the phone. No server-side session store
beyond the live in-memory subscriber map.

## Components

### Dashboard (Next.js) changes

1. **`src/lib/relay.ts`** — in-memory pub/sub. A module-level
   `Map<code, Set<(line) => void>>`. Exposes:
   - `subscribe(code, fn): () => void` — register a subscriber, returns an unsubscribe
     function that cleans up the set (and the map entry when empty).
   - `publish(code, line): number` — deliver a line to all subscribers for that code;
     returns the number of subscribers reached.
   - This is pure, framework-free logic and is the primary unit-test target.

2. **`POST /api/ingest`** (`src/app/api/ingest/route.ts`) — accepts
   `{ code: string, text: string }`. Validates non-empty code and text, calls
   `publish(code, { text, ts })`, returns `{ ok: true, delivered: <count> }`. Returns
   400 on missing/invalid fields. CORS headers allowed so the Android app can POST
   cross-origin (it will hit the tunnel origin directly, but permissive CORS keeps it
   robust).

3. **`GET /api/stream`** (`src/app/api/stream/route.ts`) — SSE endpoint. Reads `code`
   from the query string, opens a `ReadableStream`, subscribes to the relay, and
   writes each published line as an SSE `data:` event. On client disconnect (abort
   signal), unsubscribes. Sends an initial comment/heartbeat to open the stream and a
   periodic heartbeat to keep proxies from closing it. `runtime = "nodejs"`,
   `dynamic = "force-dynamic"`.

4. **`src/components/dashboard.tsx`** changes:
   - Generate a pairing code once on mount (stable across renders).
   - Open an `EventSource("/api/stream?code=...")`; on message, build a
     `TranscriptLine` with `speaker: "Phone"` and feed it through the **same**
     `setLines` + `scheduleAnalysis` path the local mic uses. No duplication of the
     analyze pipeline.
   - Track a "phone connected" / "waiting for phone" state from EventSource
     open/error events.
   - Local mic button remains; phone lines and mic lines coexist in one transcript.

5. **`src/components/header.tsx`** — display the pairing code and a small phone-status
   indicator alongside the existing recording controls.

### Android app (`android-voice/`)

Minimal native Kotlin Android Studio (Gradle) project. One screen:

- **Inputs:** base URL field (the tunnel URL), pairing-code field. Persisted to
  `SharedPreferences` so they survive restarts.
- **Mic toggle:** large start/stop button.
- **Live preview:** shows interim + last final lines locally for feedback.
- **Recognition:** `SpeechRecognizer` with a continuous restart loop (mirrors the
  dashboard's `onend` → `start()` pattern) so it keeps listening across utterances.
- **Networking:** on each **final** result, POST `{ code, text }` as JSON to
  `<baseUrl>/api/ingest`. Uses `HttpURLConnection` (no third-party HTTP lib needed) on
  a background thread.
- **Permissions:** `RECORD_AUDIO` (runtime request) and `INTERNET`.

Project includes the standard Gradle wrapper, `build.gradle(.kts)`, `AndroidManifest.xml`,
a single `MainActivity`, and a simple layout. Kept intentionally thin.

## Data flow (one utterance)

1. User speaks → Android `SpeechRecognizer` emits a final result string.
2. Android POSTs `{ code, text }` to `<tunnel>/api/ingest`.
3. `/api/ingest` calls `publish(code, { text, ts })`.
4. Relay delivers to every SSE subscriber registered under `code`.
5. `/api/stream` writes an SSE `data:` event to the dashboard browser.
6. Dashboard's `EventSource.onmessage` appends a `TranscriptLine` (`speaker: "Phone"`)
   and schedules analysis.
7. `/api/analyze` (unchanged) returns suggestion cards → right rail.

## Error handling

- **Android:** mic permission denied → inline message; recognition errors (no-speech,
  network) handled like the dashboard (ignore transient, surface fatal). POST failures
  retry once then drop the line (live data; do not block recognition).
- **Dashboard:** `EventSource` auto-reconnects on transient drop. Pairing mismatch →
  no delivery; dashboard shows "waiting for phone." Invalid ingest payload → 400.
- **Server relay:** unsubscribe on stream abort to avoid leaking subscribers; empty
  code sets are deleted from the map.

## Testing

- **Unit (relay.ts):** publish reaches all subscribers for a code; subscribers under a
  different code are NOT reached (isolation); unsubscribe removes the subscriber and
  cleans up empty entries; publish to a code with no subscribers returns 0.
- **Route-level:** POST to `/api/ingest` with a subscribed stream asserts the SSE
  stream emits the line; missing fields return 400.
- **Android:** recognition + networking glue verified manually on a device/emulator
  (build/run in Android Studio). Logic kept thin to minimize untested surface.

## Out of scope (YAGNI)

- Streaming raw audio to the server / server-side STT.
- Multi-speaker diarization.
- Transcript persistence or history.
- Auth beyond the pairing code.
- Multi-instance / serverless (Vercel) deployment of the relay — the in-memory pub/sub
  assumes a single Node process, which the `next dev` + tunnel model provides.

## Manual run procedure (for reference)

1. `cd dashboard && pnpm dev` (binds localhost:3000).
2. Expose it: `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`).
3. Open the dashboard (the tunnel URL or localhost); note the pairing code.
4. Build/run the Android app; enter the tunnel base URL + pairing code; grant mic.
5. Speak → lines appear in the dashboard transcript and suggestions populate.
