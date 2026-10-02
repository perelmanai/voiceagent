# Aural Voice (Android)

A minimal Android app that transcribes your speech **on-device** and streams each
finished line to the [Aural Intel dashboard](../dashboard) in real time.

Speak into your phone → lines appear in the dashboard transcript instantly.

## How it works

```
SpeechRecognizer (on device) → POST {code, text} → <dashboard>/api/ingest
                                                        │ in-memory relay (pairing code)
                                                        ▼
                                  dashboard browser ← SSE /api/stream
```

The phone never uploads audio — only finalized text. A short **pairing code** shown in
the dashboard header keys the relay so your transcript only reaches your dashboard.

## Setup

### 1. Start the dashboard

```bash
cd ../dashboard
pnpm dev        # listens on port 3000 on all network interfaces
```

### 2. Open the dashboard on your Mac

Go to **http://localhost:3000** in your browser.

### 3. Connect your phone (same Wi-Fi)

Your Mac and Android phone must be on the **same Wi-Fi network**.

1. In the Android app, tap **Scan QR** and scan the code shown on the dashboard.
   The app fills in your Mac's local IP and pairing code automatically.
2. Tap **Start mic** and speak. Lines appear in the dashboard transcript.

That's it — no tunnel or ngrok needed.

> **Manual entry:** if you skip the QR scan, enter your Mac's local IP
> (e.g. `http://192.168.x.x:3000`) and the 4-character code from the dashboard header.

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

## Notes

- On-device recognition restarts between utterances, so there's a brief gap between
  phrases — this is normal for Android's `SpeechRecognizer` API.
- The relay is in-memory: if you refresh the dashboard a new pairing code is generated
  and you'll need to re-scan the QR.
- The relay assumes a single dashboard process (`next dev`). Transcripts are not persisted.
