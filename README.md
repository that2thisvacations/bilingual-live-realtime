# Bilingual Live Realtime

Cloudflare Worker and Durable Object WebSocket service for Bilingual Live.

## Architecture

- One Durable Object per live session
- WebSocket Hibernation for low idle cost
- Host publishes one caption payload
- All viewers in the room receive it instantly
- Latest caption is retained for newly connected viewers
- Origin allowlist defaults to `https://bilingual-live.vercel.app` and local development

## Commands

```bash
npm install
npm run typecheck
npm run dev
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

The Vercel application remains the customer-facing frontend. This repository provides realtime transport only.
