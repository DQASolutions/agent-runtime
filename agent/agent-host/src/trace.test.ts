import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { appendTrace, readLedger, verifyLedger, ledgerPath } from './trace.js'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-'))
})
afterEach(async () => {
  await fs.remove(dir)
})

describe('case ledger — hash-chain', () => {
  it('appends with seq/prevHash chaining and verifies', async () => {
    const a = await appendTrace(dir, { tenant: 'p', actor: 'session', kind: 'step', name: 'start' })
    const b = await appendTrace(dir, { tenant: 'p', actor: 'senior', kind: 'act', name: 'emitCoDo' })
    expect(a.seq).toBe(0)
    expect(a.prevHash).toBe('0'.repeat(64))
    expect(b.seq).toBe(1)
    expect(b.prevHash).toBe(a.hash)

    const v = await verifyLedger(dir)
    expect(v).toMatchObject({ ok: true, count: 2 })
  })

  it('hash is independent of JSON key order (canonical): reorder keys, still verifies', async () => {
    const e = await appendTrace(dir, { tenant: 'p', actor: 'x', kind: 'read', name: 'q', args: { a: 1, b: 2 } })
    // Rewrite the same entry with every key in a different order (incl. nested args).
    const reordered = {
      hash: e.hash, prevHash: e.prevHash, args: { b: 2, a: 1 }, name: e.name,
      kind: e.kind, actor: e.actor, tenant: e.tenant, at: e.at, seq: e.seq,
    }
    await fs.writeFile(ledgerPath(dir), JSON.stringify(reordered) + '\n')
    // verify recomputes canonical(sorted) → same hash → ok, proving order-independence.
    expect(await verifyLedger(dir)).toMatchObject({ ok: true })
  })

  it('detects a tampered line and points at it', async () => {
    await appendTrace(dir, { tenant: 'p', actor: 'a', kind: 'step', name: 'start' })
    await appendTrace(dir, { tenant: 'p', actor: 'a', kind: 'act', name: 'emitCoDo' })
    await appendTrace(dir, { tenant: 'p', actor: 'a', kind: 'step', name: 'done' })

    // Tamper: rewrite the action name on seq 1 without recomputing the chain.
    const lines = (await readLedger(dir)).map((e) =>
      e.seq === 1 ? { ...e, name: 'somethingElse' } : e,
    )
    await fs.writeFile(ledgerPath(dir), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const v = await verifyLedger(dir)
    expect(v.ok).toBe(false)
    expect(v.brokenAt).toBe(1)
  })

  it('detects a deleted line', async () => {
    await appendTrace(dir, { tenant: 'p', actor: 'a', kind: 'step', name: 's0' })
    await appendTrace(dir, { tenant: 'p', actor: 'a', kind: 'step', name: 's1' })
    await appendTrace(dir, { tenant: 'p', actor: 'a', kind: 'step', name: 's2' })
    const all = await readLedger(dir)
    const without1 = [all[0], all[2]] // drop seq 1
    await fs.writeFile(ledgerPath(dir), without1.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const v = await verifyLedger(dir)
    expect(v.ok).toBe(false)
    expect(v.brokenAt).toBe(2) // the surviving seq=2 no longer chains / mis-positions
  })

  it('records a gate decision rationale and chains it (tamper-evident)', async () => {
    await appendTrace(dir, { tenant: 'p', actor: 'session', kind: 'step', name: 'start' })
    const g = await appendTrace(dir, {
      tenant: 'p',
      actor: 'senior',
      kind: 'gate',
      name: 'signoff',
      result: { decision: 'approved' },
      rationale: 'Đối chiếu khớp; sai lệch < ngưỡng trọng yếu nên chấp nhận.',
    })
    expect(g.rationale).toMatch(/ngưỡng trọng yếu/)
    expect(await verifyLedger(dir)).toMatchObject({ ok: true, count: 2 })

    // Tamper ONLY the rationale → chain must break at that entry (the WHY is protected).
    const lines = (await readLedger(dir)).map((e) =>
      e.seq === 1 ? { ...e, rationale: 'edited reason' } : e,
    )
    await fs.writeFile(ledgerPath(dir), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    expect(await verifyLedger(dir)).toMatchObject({ ok: false, brokenAt: 1 })
  })

  it('empty ledger verifies ok', async () => {
    const v = await verifyLedger(dir)
    expect(v).toMatchObject({ ok: true, count: 0 })
  })
})
