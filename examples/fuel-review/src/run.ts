// HEADLESS SIMULATION (regression/demo) — `npm start`. Drives the full workflow
// in a temp workspace and prints the narrative. NOTE: here the investigate
// decision is made by app.ts in code (a fixed stand-in for the agent), so this
// is a deterministic harness for CI — NOT the real app.
//
// The REAL app runs INSIDE a Claude Code session driving the `dqa-fos` CLI
// (start → call/act → done → approve), where Claude itself makes the
// investigation judgment. See `.claude/commands/fuel-review.md` and the README.

import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import fs from 'fs-extra'
import { runFuelDogfood, CASE } from './app.js'

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app')
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fuel-run-'))

try {
  console.log('=== fuel-review dogfood — full e2e ===')
  const res = await runFuelDogfood({ appDir, workspace, tenant: 'demo', caseJson: CASE, log: (m) => console.log(m) })
  console.log('\n— Tổng kết —')
  console.log(`trạng thái: ${res.status} · cờ đỏ phát: ${res.coDoCount}`)
  for (const d of res.decisions) console.log(`  ${d.id}: ${d.action} (lệch ${d.delta}đ)`)
} finally {
  await fs.remove(workspace)
}
