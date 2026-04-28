# Deployment Guide — AI Closer Platform

## Railway Setup

### 1. Install Railway CLI
```bash
npm install -g @railway/cli
```

### 2. Login & Initialize
```bash
railway login
cd /path/to/ai-closer-platform
railway init
railway add
```

### 3. Set Environment Variables
```bash
railway variables set ANTHROPIC_API_KEY=sk-ant-api03-...
railway variables set RETELL_API_KEY=key_ff9c78ea...
railway variables set VAPI_API_KEY=6b501e85-...
railway variables set ELEVENLABS_API_KEY=2b2c2b47...
railway variables set ELEVENLABS_VOICE_ID=BIvP0GN1...
railway variables set RECALL_API_KEY=3d3016ab...
railway variables set CALENDLY_API_KEY=eyJraWQ...
railway variables set TAVUS_API_KEY=093bb1ad...
railway variables set LIVEKIT_URL=wss://voice-2waod9ra.livekit.cloud
railway variables set LIVEKIT_API_KEY=APImvxjYmahJu4B
railway variables set LIVEKIT_API_SECRET=fBdZGzMva8...
railway variables set ANAM_API_KEY=N2Y5OWVh...
railway variables set SUPABASE_URL=https://sfnwkvpnpwntmyigycrd.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
railway variables set SUPABASE_ACCESS_TOKEN=sbp_83c2...
railway variables set NODE_ENV=production
railway variables set PORT=3000
```

### 4. Deploy
```bash
railway up
```

### 5. Get Your URL
```bash
railway domain
```

### 6. Set BASE_URL
```bash
railway variables set BASE_URL=https://your-app.railway.app
```
Then redeploy:
```bash
railway up
```

## Webhook Registration (After Deploy)

### Retell
1. Go to https://dashboard.retell.ai
2. Settings → Webhooks
3. Add URL: `https://your-app.railway.app/webhooks/retell`

### Calendly
Already handled via API when you call:
```
POST /clients/:id/calendly
```
The webhook URL auto-registers using BASE_URL.

### Recall
Already set in `deployRecallBot()` — uses BASE_URL automatically.

### Tavus
1. Go to Tavus dashboard
2. Webhooks → Add endpoint
3. URL: `https://your-app.railway.app/webhooks/tavus`

### LiveKit
1. Go to LiveKit Cloud dashboard
2. Webhooks → Add endpoint
3. URL: `https://your-app.railway.app/webhooks/livekit`

## Custom Domain (Optional)

### 1. Add Domain in Railway
Railway Dashboard → Settings → Custom Domain → Add your domain

### 2. Point DNS
Add a CNAME record pointing to your Railway URL:
```
CNAME  your-domain.com  →  your-app.railway.app
```

### 3. SSL
Railway auto-provisions SSL via Let's Encrypt. No configuration needed.

### 4. Update BASE_URL
```bash
railway variables set BASE_URL=https://your-domain.com
railway up
```

## Verify Deployment

```bash
curl https://your-app.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-04-06T...",
  "version": "1.0.0",
  "services": {
    "supabase": "connected",
    "retell": "connected",
    "livekit": "connected",
    "redis": "unavailable"
  },
  "uptime": 123.456
}
```

## Troubleshooting

### Server won't start
- Check `railway logs` for missing env vars
- The server logs which vars are missing on startup

### Health check returns 503
- Supabase is unreachable — check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

### Webhooks not firing
- Verify BASE_URL is set to your Railway URL (not localhost)
- Check webhook registrations in each service's dashboard

### Rate limited (429)
- General: 100 requests per 15 minutes per IP
- Webhooks: 200 requests per minute per IP
