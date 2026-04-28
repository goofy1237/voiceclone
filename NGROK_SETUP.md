# Ngrok Setup for Local Testing

Webhooks from Retell, Recall.ai, and Calendly need to reach your local server.
Ngrok exposes localhost to the internet via a public URL.

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

Restart the server after changing this.

## 4. Register Calendly Webhook

The server registers the Calendly webhook automatically when you call:

```bash
curl -X POST http://localhost:3000/clients/YOUR_CLIENT_ID/calendly \
  -H "Content-Type: application/json" \
  -d '{"event_type_uri": "https://api.calendly.com/event_types/YOUR_EVENT_TYPE_ID"}'
```

This points Calendly's `invitee.created` webhook to `{BASE_URL}/webhooks/calendly`.

## 5. Retell + Recall Webhooks

These are set automatically when creating agents/bots using the `BASE_URL` from `.env`.

## Why This Is Needed

- Calendly, Retell, and Recall.ai send webhook events to a public URL
- During local development, your machine isn't publicly accessible
- Ngrok creates a tunnel from a public URL to localhost:3000
- In production, replace BASE_URL with your actual deployment URL
