# Aural Intel

Real-time conversation co-pilot: speak into your phone, see a live transcript on the dashboard, and get Gemini-powered suggestion cards.

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
cp .env.example .env.local   # add your Gemini API key
npm install
npm run dev
```

Open http://localhost:3000 in Chrome.

### Android app

1. Open `android-voice/` in Android Studio
2. Run on a physical device (same Wi-Fi as your Mac)
3. Scan the QR code on the dashboard, tap **Start mic**, and speak

See `android-voice/README.md` for full setup details.

## Environment

- `GEMINI_API_KEY` — required for suggestion cards (`/api/analyze`)

ANOTHER IMPORTANT NOTE (Nandan Found This):

Make sure you use a PAID GEMINI API Key, as a Free one will have rate limits and the analysis will not work as well as it would have otherwise.

Never commit `.env.local` or other secret files.
