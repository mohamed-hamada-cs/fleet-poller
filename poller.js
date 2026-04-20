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

// ── Day/night schedule ─────────────────────────────────────────────────────
// During school hours (05:00–18:00 UK time) poll every 5s.
// Overnight poll every 15 minutes — vehicles are parked, no need to hammer Samsara.
const DAY_INTERVAL_MS   =      5_000   //  5 seconds
const NIGHT_INTERVAL_MS = 15 * 60_000  // 15 minutes

function isUkDayTime() {
  // Get current hour in Europe/London (handles GMT/BST automatically)
  const londonHour = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    hour:     'numeric',
    hour12:   false,
  })
  const h = parseInt(londonHour, 10)
  return h >= 5 && h < 18  // 05:00 – 17:59 UK time
}

function currentInterval() {
  return isUkDayTime() ? DAY_INTERVAL_MS : NIGHT_INTERVAL_MS
}

// ── Job definitions ────────────────────────────────────────────────────────
// Each job calls a Supabase Edge Function via HTTP POST.
const JOBS = [
  {
    name: 'samsara-location',
    path: '/functions/v1/samsara-location-webhook',
  },
  {
    name: 'samsara-fuel-snapshot',
    path: '/functions/v1/samsara-fuel-snapshot',
    fixedIntervalMs: 15 * 60_000,  // every 15 min regardless of day/night
  },
  // Add more jobs here as needed, e.g.:
  // {
  //   name: 'cert-expiry-reminders',
  //   path: '/functions/v1/cert-expiry-reminders',
  //   fixedIntervalMs: 60 * 60 * 1000,  // fixed interval, ignores day/night
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
      const interval = job.fixedIntervalMs ?? currentInterval()
      console.log(`[${job.name}] OK ${res.status} — ${new Date().toISOString()} — next in ${interval / 1000}s`)
    }
  } catch (err) {
    console.error(`[${job.name}] fetch error: ${err.message}`)
  }
}

// ── Dynamic scheduling (respects day/night interval changes) ───────────────
function scheduleJob(job) {
  const interval = job.fixedIntervalMs ?? currentInterval()
  setTimeout(async () => {
    await callJob(job)
    scheduleJob(job)  // reschedule after each run so interval can change
  }, interval)
}

// ── Start all jobs ─────────────────────────────────────────────────────────
for (const job of JOBS) {
  void callJob(job)   // fire immediately on startup
  scheduleJob(job)    // then on dynamic interval
  console.log(`[fleet-poller] scheduled: ${job.name} (day=${DAY_INTERVAL_MS / 1000}s night=${NIGHT_INTERVAL_MS / 60_000}min)`)
}

console.log(`[fleet-poller] running — ${JOBS.length} job(s) active — UK time: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`)
