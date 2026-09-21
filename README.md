# Guess It

A real-time multiplayer guessing game with a React frontend and a Cloudflare-native backend.

## Architecture

- `frontend/` — React and Vite application using the browser WebSocket API.
- `backend/` — Cloudflare Worker that routes each game room to its own Durable Object.
- Durable Object SQLite storage persists the room state.
- Durable Object alarms finish rounds after 60 seconds without keeping an instance awake.

## Run locally

Use two terminals.

```bash
cd backend
npm install
npm run cf-typegen
npm run dev
```

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

The frontend defaults to `http://localhost:8787` during development, so the
`.env.local` file is optional unless you change the backend address.

## Deploy the backend to Cloudflare

From `backend/`:

```bash
npm install
npm run cf-typegen
npm run typecheck
npm run deploy
```

The first deployment creates the SQLite-backed `GameRoom` Durable Object class
declared in `wrangler.jsonc`.

For Cloudflare Workers Builds, connect this repository and use:

- Root directory: `backend`
- Build command: `npm run typecheck`
- Deploy command: `npm run deploy`

## Configure and deploy the frontend

Set these build-time variables on the frontend host:

```text
VITE_BACKEND_URL=https://guess-it-backend.<your-workers-subdomain>.workers.dev
VITE_GAME_ROOM=main
```

Then build the Vite application:

```bash
cd frontend
npm install
npm run build
```

When using Cloudflare Pages, set `frontend` as the root directory and `dist` as
the build output directory.

## Backend endpoints

- `GET /` — service information.
- `GET /health` — health check.
- `GET /ws?room=main` with `Upgrade: websocket` — game connection.

Room IDs may contain letters, numbers, underscores, and hyphens. Each room is
routed to a separate Durable Object instance.
