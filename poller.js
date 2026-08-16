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

// Optional — set only on the environment whose Edge Function points at the simulator (staging).
// Without them the simulator gate is simply off and this behaves as it always did.
const SIM_URL        = (process.env.SIM_URL || '').replace(/\/$/, '')
const SIM_SECRET     = process.env.SIM_CONTROL_SECRET || ''

if (!SUPABASE_URL)  throw new Error('Missing env: SUPABASE_URL')
if (!POLLER_SECRET) throw new Error('Missing env: POLLER_SECRET')

// ── When to poll fast ──────────────────────────────────────────────────────
// School runs happen on weekday mornings and afternoons, so that window is polled every 5s.
// Outside it, vans are parked and there is nothing to see — EXCEPT when someone is running a
// simulated trip, which can be at any hour. So outside the window we ask the simulator (our own
// VPS, costs nothing) and only spend a Supabase invocation when a simulated vehicle is actually
// under way. A 15-minute floor stays in place so a real vehicle moving overnight — a theft, a
// van taken home — still shows up rather than the map freezing until morning.
const FAST_INTERVAL_MS = 5_000        // 5 seconds
const FLOOR_INTERVAL_MS = 15 * 60_000 // 15 minutes — the slowest we ever go
const TICK_MS = FAST_INTERVAL_MS      // how often we DECIDE; deciding is local and free

// 20s, not the 60s this used to be. 60s was inherited from when this was a 15-minute job; on a
// 5-second job a reply that arrives after a minute is worthless, and waiting for it blanked the
// map for 71 seconds — far enough for a van to drive through a 150m geofence unseen. 20s is
// chosen from the data: the slowest SUCCESSFUL call ever recorded is 14.2s, so anything shorter
// would start aborting work that was about to succeed.
const DEFAULT_TIMEOUT_MS = 20_000

// States that mean a simulated trip is under way. A vehicle sitting paused or finished is a
// leftover from an earlier test — polling fast for it all night is the waste we are removing.
const SIM_ACTIVE_STATES = ['driving', 'dwelling', 'waiting', 'breakdown', 'crash']

function ukParts() {
  // Europe/London handles GMT/BST automatically.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', hour12: false, weekday: 'short',
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))
  return { hour: parseInt(parts.hour, 10), weekday: parts.weekday }
}

function isSchoolWindow() {
  const { hour, weekday } = ukParts()
  const weekend = weekday === 'Sat' || weekday === 'Sun'
  return !weekend && hour >= 5 && hour < 18  // 05:00 – 17:59 UK time, Mon–Fri
}

let simWarned = false

async function simulatorIsBusy() {
  if (!SIM_URL || !SIM_SECRET) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const res = await fetch(`${SIM_URL}/sim/vehicles`, {
      headers: { Authorization: `Bearer ${SIM_SECRET}` },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const fleet = await res.json()
    simWarned = false
    return Array.isArray(fleet) && fleet.some((v) => SIM_ACTIVE_STATES.includes(v.state))
  } catch (err) {
    clearTimeout(timeout)
    // Unreachable simulator means no simulated test is running that we can see. Say so once
    // rather than every 5 seconds, and fall back to the floor — never to fast polling.
    if (!simWarned) {
      console.warn(`[sim-gate] simulator unreachable (${err.message}) — falling back to the ${FLOOR_INTERVAL_MS / 60_000}min floor`)
      simWarned = true
    }
    return false
  }
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
async function callJob(job, reason = '') {
  const url = `${SUPABASE_URL}${job.path}`
  const controller = new AbortController()
  const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${POLLER_SECRET}`,
        'Content-Type':  'application/json',
      },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    const text = await res.text()
    if (!res.ok) {
      console.error(`[${job.name}] HTTP ${res.status}: ${text}`)
    } else {
      console.log(`[${job.name}] OK ${res.status} — ${new Date().toISOString()}${reason ? ` — ${reason}` : ''}`)
    }
  } catch (err) {
    clearTimeout(timeout)
    const msg = err.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : err.message
    console.error(`[${job.name}] fetch error: ${msg}`)
  }
}

// ── Fixed-interval jobs ────────────────────────────────────────────────────
function scheduleFixed(job) {
  setTimeout(async () => {
    await callJob(job)
    scheduleFixed(job)
  }, job.fixedIntervalMs)
}

// ── Demand-driven job ──────────────────────────────────────────────────────
// Ticks every 5s and decides each time. Deciding is local, so a simulated trip started at any
// hour is picked up within one tick instead of waiting out a 15-minute sleep — which is what
// the old "choose the interval, then sleep it" scheduler did.
function scheduleDynamic(job) {
  let lastCallMs = 0
  let inFlight = false

  const tick = async () => {
    setTimeout(tick, TICK_MS)   // schedule the NEXT tick first — see note below

    // One call at a time. The tick no longer waits for the call to finish, so a stalled request
    // costs only the samples it overlaps instead of stopping the clock: the old shape was
    // "call, await, then sleep 5s", which turned a 20s stall into a 25s gap and made the real
    // cadence 5s + however long the call took (6.4s staging, 12.1s production — never the 5s
    // the docs claimed). Skipping rather than queueing means we never build a backlog of
    // requests against a service that is already struggling.
    if (inFlight) return

    const sinceMs = Date.now() - lastCallMs
    let reason = ''

    if (isSchoolWindow()) {
      reason = 'school window'
    } else if (await simulatorIsBusy()) {
      reason = 'simulated trip running'
    } else if (sinceMs >= FLOOR_INTERVAL_MS) {
      reason = `${FLOOR_INTERVAL_MS / 60_000}min floor`
    }

    if (!reason) return

    inFlight = true
    lastCallMs = Date.now()
    try {
      await callJob(job, reason)
    } finally {
      inFlight = false
    }
  }

  void tick()
}

// ── Start all jobs ─────────────────────────────────────────────────────────
for (const job of JOBS) {
  if (job.fixedIntervalMs) {
    void callJob(job)
    scheduleFixed(job)
    console.log(`[fleet-poller] scheduled: ${job.name} (every ${job.fixedIntervalMs / 60_000}min)`)
  } else {
    scheduleDynamic(job)
    console.log(`[fleet-poller] scheduled: ${job.name} (fast=${FAST_INTERVAL_MS / 1000}s in school window, floor=${FLOOR_INTERVAL_MS / 60_000}min, simulator gate ${SIM_URL ? 'ON' : 'off'})`)
  }
}

console.log(`[fleet-poller] running — ${JOBS.length} job(s) active — UK time: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`)
