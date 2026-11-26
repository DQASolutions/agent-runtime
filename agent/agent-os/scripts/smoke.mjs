// Smoke test for the always-on service-skeleton (DoD F, process level):
// start `dist/service/main.js`, POST an event, confirm the drain loop turns it
// into a doc + a spawned run, observable via GET /state. Exits non-zero on fail.
//
// Usage: node agent/agent-os/scripts/smoke.mjs [baseUrl]
//   - no arg: spawns main.js on an ephemeral port and tears it down
//   - baseUrl (e.g. http://127.0.0.1:8080): tests an already-running service

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const here = path.dirname(fileURLToPath(import.meta.url))
const mainJs = path.join(here, '..', 'dist', 'service', 'main.js')

async function waitFor(fn, tries = 60, gap = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* not ready */
    }
    await delay(gap)
  }
  return null
}

async function run(base, child) {
  const health = await waitFor(async () => (await fetch(`${base}/health`)).ok)
  if (!health) throw new Error('service did not become healthy')

  const post = await fetch(`${base}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant: 'default', app: 'demo', action: 'demo_ingestDoc', params: { ref: 'D1', props: { title: 'x' } } }),
  })
  if (post.status !== 202) throw new Error(`POST /events expected 202, got ${post.status}`)

  const state = await waitFor(async () => {
    const s = await (await fetch(`${base}/state`)).json()
    return s.docs === 1 && s.runs === 1 ? s : null
  })
  if (!state) throw new Error('drain loop did not produce docs=1, runs=1')
  console.log(`SMOKE OK — POST /events → ${JSON.stringify(state)}`)
}

const arg = process.argv[2]
let child = null
const base = arg ?? 'http://127.0.0.1:8137'
if (!arg) {
  child = spawn('node', [mainJs], { env: { ...process.env, PORT: '8137' }, stdio: 'inherit' })
}
try {
  await run(base, child)
  child?.kill('SIGTERM')
  process.exit(0)
} catch (e) {
  console.error('SMOKE FAIL —', e.message)
  child?.kill('SIGTERM')
  process.exit(1)
}
