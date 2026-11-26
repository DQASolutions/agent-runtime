// Full e2e dogfood test — drives the COMPLETE workflow (ingest → check →
// investigate via command-set → gate) through FieldSession via the run driver.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFuelDogfood, CASE } from './app.js'
import { readLedger, verifyLedger } from '@dqa-ai-solutions/agent-runtime'

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app')
let workspace: string

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fuel-test-'))
})
afterEach(async () => {
  await fs.remove(workspace)
})

describe('fuel-review — dogfood full e2e (FieldSession + command-set)', () => {
  it('điều tra: g1 thật → cờ đỏ, g4 ngoại lệ → ghi nhận; gate duyệt; complete', async () => {
    const res = await runFuelDogfood({ appDir, workspace, tenant: 'demo', caseJson: CASE })
    expect(res.status).toBe('complete')
    expect(res.coDoCount).toBe(1) // chỉ g1 phát cờ đỏ
    expect(res.decisions.filter((d) => d.action === 'emitCoDo').length).toBe(1)
    expect(res.decisions.filter((d) => d.action === 'note').length).toBe(1) // g4 ngoại lệ

    // Step 2 — the case ledger tells the whole story, tamper-evident.
    const tenantDir = path.join(workspace, '.dqa', 'projects', 'demo')
    const ledger = await readLedger(tenantDir)
    const kinds = new Set(ledger.map((e) => e.kind))
    // start → deterministic steps → reads/calls during investigate → governed
    // write → gate decision → complete are all present.
    expect(kinds).toEqual(new Set(['step', 'read', 'call', 'act', 'note', 'gate']))
    expect(ledger[0]).toMatchObject({ seq: 0, kind: 'step', name: 'start' })
    expect(ledger.some((e) => e.kind === 'step' && e.name === 'complete')).toBe(true)

    const acts = ledger.filter((e) => e.kind === 'act' && e.name === 'emitCoDo')
    expect(acts).toHaveLength(1)
    expect(acts[0]?.provenance?.confirmed_by).toBe('senior')
    expect(ledger.some((e) => e.kind === 'gate' && (e.result as { decision?: string })?.decision === 'approved')).toBe(true)

    // The chain verifies; flipping one byte breaks it at that line.
    expect(await verifyLedger(tenantDir)).toMatchObject({ ok: true })
  })

  it('kỳ sạch → không điều tra, không cờ đỏ, complete ngay', async () => {
    const clean = JSON.stringify({
      instances: [{ type: 'GiaoDich', props: { amount: 2_000_000, category: 'tiếp khách' }, ref: 'g1' }],
      links: [],
    })
    const res = await runFuelDogfood({ appDir, workspace, tenant: 'clean', caseJson: clean })
    expect(res.status).toBe('complete')
    expect(res.coDoCount).toBe(0)
    expect(res.decisions.length).toBe(0)
  })
})
