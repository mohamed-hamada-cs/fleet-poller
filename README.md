# fleet-poller

VPS background process that calls Supabase Edge Functions on a fixed interval.

Requires Node.js ≥ 18 (no dependencies — uses the built-in `fetch`).

---

## Setup

```bash
cp .env.example .env
# Edit .env — fill in SUPABASE_URL and POLLER_SECRET
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL, e.g. `https://ilpfknjpfmgvzjafqtls.supabase.co` |
| `POLLER_SECRET` | Shared secret. Must match `POLLER_SECRET` set in Supabase Edge Function secrets |

---

## Run locally (testing)

```bash
node poller.js
```

---

## Deploy on VPS with PM2

```bash
# Install PM2 globally (once)
npm install -g pm2

# Start the poller
npm run start:pm2

# Persist across reboots
pm2 save
pm2 startup   # follow the printed command to register the init script
```

Useful PM2 commands:

```bash
pm2 logs fleet-poller       # tail live logs
pm2 restart fleet-poller    # restart after config change
pm2 stop fleet-poller       # stop
pm2 delete fleet-poller     # remove from PM2
```

---

## Adding a new job

Edit `poller.js` — append a new entry to the `JOBS` array:

```js
{
  name:       'my-new-job',
  path:       '/functions/v1/my-edge-function',
  intervalMs: 60_000,   // every 60 seconds
}
```

Restart the process after editing.

---

## Jobs

| Name | Edge Function | Interval |
|------|---------------|----------|
| `samsara-location` | `samsara-location-webhook` | 5 s |

---

## Architecture

```
fleet-poller (VPS, PM2)
   │  POST /functions/v1/samsara-location-webhook
   │  Authorization: Bearer <POLLER_SECRET>
   ▼
Supabase Edge Function: samsara-location-webhook
   │  GET /fleet/vehicles/stats?types=gps,engineStates
   ▼
Samsara EU API
   │  upsert vehicles_realtime
   ▼
Supabase DB (Realtime enabled)
   │  WebSocket NOTIFY
   ▼
Dashboard browser (LiveOperationsPanel.tsx)
```
