# Ngrok Setup for Local Testing

Retell webhooks need to reach your local server. Ngrok exposes localhost to the
internet via a public URL.

## 1. Install ngrok

```bash
brew install ngrok    # macOS
# or download from https://ngrok.com/download
```

## 2. Start ngrok

```bash
ngrok http 3000
```

This gives you a URL like `https://abc123.ngrok-free.app`.

## 3. Update .env

Set `BASE_URL` to your ngrok URL:

```
BASE_URL=https://abc123.ngrok-free.app
```

Restart the server after changing this — the Retell webhook URL is derived from
`BASE_URL` when agents are created.

## Why this is needed

- Retell sends webhook events (`/webhooks/retell`) to a public URL
- During local development, your machine isn't publicly accessible
- Ngrok creates a tunnel from a public URL to localhost:3000
- In production, replace `BASE_URL` with your Railway URL (see [DEPLOY.md](DEPLOY.md))
