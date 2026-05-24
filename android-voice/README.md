# Aural Voice (Android)

A minimal Android app that transcribes your speech **on-device** and streams each
finished line to the [Aural Intel dashboard](../dashboard) in real time.

It's the phone-side companion to the dashboard: speak into the phone, and lines appear
in the dashboard transcript instantly, feeding the same Gemini suggestion pipeline.

## How it works

```
SpeechRecognizer (on device) → POST {code, text} → <dashboard>/api/ingest
                                                        │ in-memory relay (pairing code)
                                                        ▼
                                  dashboard browser ← SSE /api/stream
```

The phone never uploads audio — only finalized text. A short **pairing code** shown in
the dashboard header keys the relay so your transcript only reaches your dashboard.

## Build & run

Requires **Android Studio** (Giraffe or newer). The Gradle wrapper JAR is not committed,
so let Android Studio provide Gradle:

1. Open the `android-voice/` folder in Android Studio. It will sync Gradle and download
   dependencies (AGP 8.5.2 / Gradle 8.7 / Kotlin 1.9.24, compileSdk 34).
   - CLI alternative: run `gradle wrapper` once in this folder to generate
     `gradlew` + `gradle/wrapper/gradle-wrapper.jar`, then `./gradlew installDebug`.
2. Connect a **physical phone** with USB debugging (recommended — emulators often lack
   Google speech services) and Run.
3. Grant the microphone permission when prompted.

## Connecting to the dashboard

The phone needs to reach the dashboard over the network. Run the dashboard and expose it:

```bash
cd ../dashboard
pnpm dev                       # http://localhost:3000
# in another terminal, expose it publicly:
ngrok http 3000                # or: cloudflared tunnel --url http://localhost:3000
```

Then in the app:

1. **Dashboard URL** — the public tunnel URL (e.g. `https://abcd-1234.ngrok-free.app`).
   `http://`/`https://` is added automatically if you omit it.
2. **Pairing code** — the 4-character code shown in the dashboard header (e.g. `K7Q2`).
3. Tap **Start mic** and speak. The dashboard header's phone chip turns green and your
   lines stream into the transcript.

Both fields are remembered between launches.

## Notes / limitations

- On-device recognition restarts between utterances (mirrors the dashboard's browser
  loop), so there's a brief gap between phrases — expected with `SpeechRecognizer`.
- The relay is in-memory and assumes a single dashboard process (the `next dev` + tunnel
  model). No transcripts are persisted.
- LAN-only alternative: skip the tunnel and use the laptop's local IP
  (`http://192.168.x.x:3000`) if the phone is on the same Wi-Fi.
