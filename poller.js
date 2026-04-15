/**
 * fleet-poller
 *
 * Calls Supabase Edge Functions on configurable intervals.
 * Runs as a persistent process on the VPS (managed by PM2 or Coolify).
 *
 * Auth: sends POLLER_SECRET as Bearer token — the Edge Function validates it.
 *
 * To add a new job, append an entry to the JOBS array below.
 */

'use strict'

// Load .env file if present (works with PM2 which doesn't auto-load .env)
const fs = require('fs')
const path = require('path')
const envPath = path.join(__dirname, '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
}

const SUPABASE_URL   = process.env.SUPABASE_URL   // e.g. https://ilpfknjpfmgvzjafqtls.supabase.co
const POLLER_SECRET  = process.env.POLLER_SECRET   // shared secret set in Supabase Edge Function secrets

if (!SUPABASE_URL)  throw new Error('Missing env: SUPABASE_URL')
if (!POLLER_SECRET) throw new Error('Missing env: POLLER_SECRET')

// ── Job definitions ────────────────────────────────────────────────────────
// Each job calls a Supabase Edge Function via HTTP POST.
// intervalMs: how often to call it (minimum ~1000ms in practice)
const JOBS = [
  {
    name:        'samsara-location',
    path:        '/functions/v1/samsara-location-webhook',
    intervalMs:  5_000,   // every 5 seconds
  },
  // Add more jobs here as needed, e.g.:
  // {
  //   name:       'cert-expiry-reminders',
  //   path:       '/functions/v1/cert-expiry-reminders',
  //   intervalMs: 60 * 60 * 1000,  // every hour
  // },
]

// ── Runner ─────────────────────────────────────────────────────────────────
async function callJob(job) {
  const url = `${SUPABASE_URL}${job.path}`
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${POLLER_SECRET}`,
        'Content-Type':  'application/json',
      },
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[${job.name}] HTTP ${res.status}: ${text}`)
    } else {
      console.log(`[${job.name}] OK ${res.status} — ${new Date().toISOString()}`)
    }
  } catch (err) {
    // Network error — log and continue. PM2 will restart the process if it crashes.
    console.error(`[${job.name}] fetch error: ${err.message}`)
  }
}

// ── Schedule all jobs ──────────────────────────────────────────────────────
for (const job of JOBS) {
  // Fire immediately on startup, then on interval
  void callJob(job)
  setInterval(() => void callJob(job), job.intervalMs)
  console.log(`[fleet-poller] scheduled: ${job.name} every ${job.intervalMs / 1000}s`)
}

console.log(`[fleet-poller] running — ${JOBS.length} job(s) active`)
