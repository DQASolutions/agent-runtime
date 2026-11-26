import { describe, it, expect } from 'vitest'
import { createOntology, InMemoryAdapter, type Ctx, type Provenance } from '@dqa-ai-solutions/ontology-runtime'
import type { StepContext } from '@dqa-ai-solutions/agent-orchestrator'
import { loadOntology } from '@dqa-ai-solutions/ontology-runtime'
import { checkExecutor } from './executors.js'
import { rule } from '@dqa-ai-solutions/ontology-runtime'

const ctx: Ctx = { tenantId: 't', actor: 'a' }
const prov: Provenance = { source_ref: 'test', confirmed_by: 'a', confirmed_at: '2026-01-01T00:00:00.000Z' }

const step = (types?: string[]): StepContext =>
  ({ task: { task: 'check', with: types ? { types } : {} }, projectBaseDir: '' } as unknown as StepContext)

async function setup() {
  const ont = createOntology({ adapter: new InMemoryAdapter() })
  await loadOntology(ont, { entities: [{ name: 'GiaoDich', label: 'GD', properties: [{ name: 'category', type: 'text' as const }] }] }, ctx)
  await ont.applyAction('createInstance', { type: 'GiaoDich', props: { category: 'xăng' } }, prov, ctx)
  await ont.applyAction('createInstance', { type: 'GiaoDich', props: { category: 'tiếp khách' } }, prov, ctx)
  return ont
}

describe('checkExecutor', () => {
  it('flags instances matching a per-instance rule (khi)', async () => {
    const ont = await setup()
    const rulesByType = { GiaoDich: [rule({ on: 'GiaoDich', id: 'R-XANG', severity: 'cao', khi: (g) => g.data.category === 'xăng' })] }
    const res = await checkExecutor(ont, ctx, rulesByType).run(step(['GiaoDich']))
    expect(res.exports!.flagged).toBe(true)
    expect(res.exports!.count).toBe(1)
    expect((res.exports!.byRule as Record<string, number>)['R-XANG']).toBe(1)
    expect((res.exports!.flaggedIds as string[]).length).toBe(1)
  })

  it('clean (flagged=false) when no rule matches', async () => {
    const ont = await setup()
    const rulesByType = { GiaoDich: [rule({ on: 'GiaoDich', id: 'R-NONE', khi: (g) => g.data.category === 'không-có' })] }
    const res = await checkExecutor(ont, ctx, rulesByType).run(step(['GiaoDich']))
    expect(res.exports!.flagged).toBe(false)
    expect(res.exports!.count).toBe(0)
  })

  it('collection rule (timViPham) returns its own violators', async () => {
    const ont = await setup()
    const rulesByType = { GiaoDich: [rule({ on: 'GiaoDich', id: 'R-ALL', timViPham: (io) => io.find('GiaoDich') })] }
    const res = await checkExecutor(ont, ctx, rulesByType).run(step(['GiaoDich']))
    expect(res.exports!.count).toBe(2)
  })

  it('defaults to all rule-types when with.types is omitted', async () => {
    const ont = await setup()
    const rulesByType = { GiaoDich: [rule({ on: 'GiaoDich', id: 'R-XANG', khi: (g) => g.data.category === 'xăng' })] }
    const res = await checkExecutor(ont, ctx, rulesByType).run(step())
    expect(res.exports!.count).toBe(1)
  })

  it('carries a Finding (message/delta/label/category) when a rule returns one', async () => {
    const ont = await setup()
    const rulesByType = {
      GiaoDich: [
        rule({
          on: 'GiaoDich',
          id: 'R-XANG',
          category: 'sai',
          khi: (g) => (g.data.category === 'xăng' ? { label: 'GD xăng', delta: 500, message: 'giao dịch xăng nghi vấn' } : false),
        }),
      ],
    }
    const res = await checkExecutor(ont, ctx, rulesByType).run(step(['GiaoDich']))
    const findings = res.exports!.findings as Array<Record<string, unknown>>
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ ruleId: 'R-XANG', category: 'sai', label: 'GD xăng', delta: 500, message: 'giao dịch xăng nghi vấn' })
    expect((res.exports!.byCategory as Record<string, number>).sai).toBe(1)
  })

  it('enriches a boolean rule via moTa', async () => {
    const ont = await setup()
    const rulesByType = {
      GiaoDich: [
        rule({
          on: 'GiaoDich',
          id: 'R-TK',
          khi: (g) => g.data.category === 'tiếp khách',
          moTa: (g) => ({ message: `tiếp khách: ${g.id}`, delta: 1, category: 'thieu' }),
        }),
      ],
    }
    const res = await checkExecutor(ont, ctx, rulesByType).run(step(['GiaoDich']))
    const findings = res.exports!.findings as Array<Record<string, unknown>>
    expect(findings[0]).toMatchObject({ ruleId: 'R-TK', category: 'thieu', delta: 1 })
    expect(findings[0].message).toContain('tiếp khách')
  })
})
