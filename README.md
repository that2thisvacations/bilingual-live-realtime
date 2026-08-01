# Bilingual Live Realtime

Cloudflare Worker and Durable Object WebSocket service for Bilingual Live.

## Architecture

- One Durable Object per live session
- WebSocket Hibernation for low idle cost
- Host publishes one caption payload
- All viewers in the room receive it instantly
- Latest caption is retained for newly connected viewers
- English, Spanish, and French captions are shared once per update, never translated per viewer
- Viewer language presence is aggregated in memory for the active room
- Origin allowlist defaults to `https://bilingual-live.vercel.app` and its Vercel preview deployments

## Commands

```bash
npm install
npm run typecheck
npm run dev
npm run smoke:realtime
npm run deploy
```

## Optional Cloudflare variable

Set `ALLOWED_ORIGINS` to a comma-separated list when adding preview or custom domains.

Example:

```text
https://bilingual-live.vercel.app,http://localhost:3000
```

## Routes

- `GET /health`
- `GET /rooms/:sessionId`
- `WS /rooms/:sessionId?role=host`
- `WS /rooms/:sessionId?role=viewer`

Viewers announce `en`, `es`, or `fr` with a `viewer-language` message. The host publishes one multilingual caption containing all three translations; the Worker persists and broadcasts that payload unchanged.

The Vercel application remains the customer-facing frontend. This repository provides realtime transport only.
