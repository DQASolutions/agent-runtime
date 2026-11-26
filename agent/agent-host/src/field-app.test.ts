import { describe, it, expect } from 'vitest'
import type { WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'
import { FieldApp } from './field-app.js'

const ontology = {
  entities: [
    { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' as const }] },
    { name: 'document', label: 'Document', properties: [] },
  ],
  relationships: [{ name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N' as const, directed: true }],
}
const rules = {
  rules: [{ id: 'R-PROOF', kind: 'REQUIRED_RELATION' as const, appliesTo: 'invoice', condition: { op: 'absent' as const, relationship: 'proves' }, message: 'Invoice {id} lacks proof.', severity: 'HIGH' }],
}
const workflow = {
  name: 'review', version: 3, pipeline: [{ phase: 'p' }],
  phases: { p: { tasks: [
    { id: 'map', type: 'agent-task', uses: 'ingest', depends: [] },
    { id: 'screen', type: 'agent-task', uses: 'evaluate-rules', with: { entityTypes: ['invoice'] }, outputs: { flagged: { type: 'boolean' }, findings: { type: 'number' } }, depends: ['map'] },
    { id: 'gate', type: 'gate', 'gate-type': 'approval', description: 'sign off', depends: ['screen'], when: 'screen.flagged == true' },
    { id: 'decide', type: 'agent-task', uses: 'report', with: { entityTypes: ['invoice'], output: 'report.md' }, depends: ['screen'] },
  ] } },
} as unknown as WorkflowV3

describe('FieldApp — one-line app boot', () => {
  it('boots from declarations and runs two tenants in isolation', async () => {
    const app = await FieldApp.load({ ontology, rules, workflow })

    // flagged tenant: two unproven invoices
    const flagged = await app.run(
      JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }, { type: 'invoice', props: { amount: 2 } }] }),
      { tenant: 'acme', onGate: () => true },
    )
    expect(flagged.status).toBe('complete')
    expect(flagged.gateApproved).toBe(true)
    // Ingest goes through the bulk write door: ONE coarse audit entry for the batch,
    // not one per instance (governed-ontology-port ingestBulk, since 7/2026).
    // Both instances were still written: the screen below finds two.
    expect(flagged.audited).toBe(1)
    expect((flagged.exports.screen as { findings?: number })?.findings).toBe(2)
    expect(flagged.report).toContain('Total findings: 2')

    // clean tenant: a proven invoice (isolated — same app, different tenant)
    const clean = await app.run(
      JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 9 }, ref: 'i' }, { type: 'document', props: {}, ref: 'd' }], links: [{ relationship: 'proves', from: 'i', to: 'd' }] }),
      { tenant: 'beta', onGate: () => true },
    )
    expect(clean.status).toBe('complete')
    expect(clean.gateApproved).toBe(false) // gate skipped
    expect(clean.report).toContain('No rules fired')
  })
})
