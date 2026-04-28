# AI Closer Platform

A B2B AI Human Platform that deploys fully conversational AI sales agents. Each agent has a complete human personality (soul), joins Google Meet calls, reads prospect emotions in real time, remembers every interaction, and gets smarter after every call. Built with Claude, Retell, Tavus, LiveKit, ElevenLabs, and Recall.ai.

## Architecture — 6-Layer Stack

| Layer | Purpose | Tech |
|-------|---------|------|
| **Soul** | Human personality, backstory, communication style | Claude (Anthropic) |
| **Voice** | Natural speech synthesis and voice cloning | ElevenLabs, Retell, Vapi |
| **Video** | Photorealistic face/body rendering | Tavus Phoenix-4, Anam CARA-3 |
| **Perception** | Real-time emotion & engagement detection | Raven-1, LiveKit |
| **Memory** | Per-prospect recall across all calls | Supabase + Claude analysis |
| **Presence** | Joins Google Meet as a participant | Recall.ai, LiveKit rooms |

## Setup

```bash
git clone <repo-url>
cd ai-closer-platform
npm install
cp .env.example .env  # Fill in your API keys
npm start
```

Open http://localhost:3000 for the landing page, or http://localhost:3000/dashboard to create a client.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for soul generation and call analysis |
| `RETELL_API_KEY` | Yes | Retell.ai for voice agents |
| `VAPI_API_KEY` | Yes | Vapi for setter agents |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs voice synthesis |
| `ELEVENLABS_VOICE_ID` | No | Default voice ID |
| `RECALL_API_KEY` | Yes | Recall.ai for Google Meet bots |
| `TAVUS_API_KEY` | Yes | Tavus for video avatars |
| `LIVEKIT_URL` | Yes | LiveKit WebSocket URL |
| `LIVEKIT_API_KEY` | Yes | LiveKit API key |
| `LIVEKIT_API_SECRET` | Yes | LiveKit API secret |
| `ANAM_API_KEY` | No | Anam CARA-3 face rendering |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `SUPABASE_ACCESS_TOKEN` | No | Supabase Management API token |
| `CALENDLY_API_KEY` | No | Calendly for scheduling integration |
| `BASE_URL` | No | Server URL (default: http://localhost:3000) |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Environment (development/production) |

## API Endpoints

### Core
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/clients` | Create client (onboarding) |
| `POST` | `/clients/:id/calendly` | Setup Calendly webhook |
| `GET` | `/clients/:id/prompt/:prospectId` | Live stitched prompt |
| `GET` | `/prospects/:id/memory` | Prospect memory record |
| `POST` | `/calls/phone/:prospectId` | Retell outbound call |
| `POST` | `/calls/meet` | Deploy Recall bot |

### Video (Sprint 5)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/clients/:id/tavus/replica` | Upload training video |
| `POST` | `/clients/:id/tavus/persona` | Create Tavus persona |
| `POST` | `/clients/:id/video-mode` | Set video mode |
| `POST` | `/calls/video/:prospectId` | Start Tavus video call |
| `GET` | `/calls/:id/video-status` | Poll video call status |

### Hyper-Real (Sprint 6)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/clients/:id/anam/persona` | Create Anam persona |
| `POST` | `/clients/:id/render-mode` | Set render engine |
| `POST` | `/calls/hyper-real/:prospectId` | Start hyper-real session |
| `GET` | `/sessions/:id/status` | Session status |
| `WS` | `/ws/video/:sessionId` | Live session WebSocket |

### Dashboard API
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/clients/:id/info` | Client info |
| `GET` | `/api/clients/:id/stats` | Aggregate stats |
| `GET` | `/api/clients/:id/calls` | Call history |
| `GET` | `/api/clients/:id/prospects` | All prospects |
| `GET` | `/api/calls/:id/full` | Full call detail |
| `POST` | `/api/calls/test` | Test call |

### Webhooks
| Path | Source |
|------|--------|
| `/webhooks/retell` | Retell call events |
| `/webhooks/recall` | Recall bot events |
| `/webhooks/calendly` | Calendly scheduling |
| `/webhooks/tavus` | Tavus conversation events |
| `/webhooks/livekit` | LiveKit room events |

### Health
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Deep health check with service status |

## Sprint History

| Sprint | Focus | Tests |
|--------|-------|-------|
| 1 | Core infrastructure — soul, agents, prompts, database | 15/15 |
| 2 | Memory loop — call analysis, prospect memory, agent updates | 16/16 |
| 3 | Recall.ai — Google Meet bot integration | 19/19 |
| 4 | Dashboard + multi-tenant auth | 27/27 |
| 5 | Tavus CVI — video avatars, 4 video modes | 30/30 |
| 6 | Hyper-Real — LiveKit, Raven, Phoenix-4, Anam CARA-3 | 32/32 |
| 7 | Production deployment — Railway, security, rate limiting | See tests |

## Deploy to Railway

See [DEPLOY.md](DEPLOY.md) for full deployment instructions.

Quick version:
```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```
