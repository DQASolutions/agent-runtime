import { describe, it, expect } from 'vitest'
import { runCase, cases } from './app.js'

const risky = cases.find((c) => c.name.includes('Shell'))!
const clean = cases.find((c) => c.name.includes('Acme'))!

describe('KYC dogfood — driven like a Claude Code session (FieldSession)', () => {
  it('risky: deterministic screen → agent assessment → compliance gate → complete', async () => {
    const r = await runCase(risky)
    expect(r.status).toBe('complete')
    expect(r.agentSteps).toBe(1) // the `assess` skill step surfaced and was handled
    expect(r.gateApproved).toBe(true)
    expect(r.report).toContain('Total findings: 5')
    expect(r.report).toContain('R-STRUCTURING')
  })

  it('clean: no findings → no agent step, gate skipped → complete', async () => {
    const r = await runCase(clean)
    expect(r.status).toBe('complete')
    expect(r.agentSteps).toBe(0)
    expect(r.gateApproved).toBe(false)
    expect(r.report).toContain('No rules fired')
  })
})
