# AI Closer Platform

B2B AI voice agent for sales calls — Claude + Retell + Supabase.

## What it does

Each client signs up to get a fully personified AI sales agent. We generate a complete persona ("soul"), build a system prompt that adapts per prospect, and place outbound phone calls through Retell. Every call is transcribed, analysed by Claude, and folded back into per-prospect memory so the agent gets sharper with every conversation. A multi-tenant dashboard exposes call history, prospect lists, and live call status.

## Setup

```bash
git clone <repo-url>
cd voice
npm install
cp .env .env.local   # or just edit .env directly
# Fill in ANTHROPIC_API_KEY, RETELL_API_KEY, RETELL_PHONE_NUMBER,
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
# Then run setup.sql in the Supabase SQL editor (one-time)
npm start
```

Open http://localhost:3000 for the landing page or http://localhost:3000/dashboard for the team dashboard.

## Required env vars

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude — soul gen, prompt building, call analysis |
| `RETELL_API_KEY` | Retell — voice agents + telephony |
| `RETELL_PHONE_NUMBER` | E.164 outbound caller ID (buy in Retell dashboard) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |

See `.env` for the full list including the optional `SUPABASE_ACCESS_TOKEN` (auto-migrations) and `ELEVENLABS_*` (custom voice clones, used in a later prompt).

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/clients` | Create client + generate soul + create Retell agent |
| `GET`  | `/clients/:id/prompt/:prospectId` | Live stitched system prompt |
| `GET`  | `/prospects/:id/memory` | Full prospect memory record |
| `POST` | `/calls/phone/:prospectId` | Place outbound Retell call |
| `POST` | `/calls/quick` | Dashboard "Call Me Now" |
| `GET`  | `/calls/:id/status` | Live call status |
| `GET`  | `/api/clients/:id/{stats,calls,prospects,info}` | Dashboard data |
| `GET`  | `/api/calls/:id/full` | Full call detail |
| `POST` | `/webhooks/retell` | Retell call event webhook |
| `GET`  | `/health` | Deep health check |

## Deployment

Deploys cleanly to Railway. See [DEPLOY.md](DEPLOY.md) for env vars, webhook registration, and the verification curl.

A `Dockerfile` + `fly.toml` are also kept for spinning up Fly.io test instances; CI in `.github/workflows/fly-deploy.yml` pushes to Fly on every commit to `main` (requires the `FLY_API_TOKEN` GitHub secret). Production is Railway.
