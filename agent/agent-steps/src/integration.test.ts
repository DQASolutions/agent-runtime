/**
 * Increment-2 proof: the ENGINE drives an ontology-backed workflow that is
 * pure declarations — ontology + rules loaded by the kernel loaders, steps run
 * by the kernel ontology executors. No app driver code anywhere here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import { Orchestrator, WorkflowRunner, type WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'
import { createOntology, InMemoryAdapter } from '@dqa-ai-solutions/ontology-runtime'
import { GovernedOntologyPort, auditInterceptor, type AuditRecord } from '@dqa-ai-solutions/ontology-runtime'
import { loadOntology, loadRules } from '@dqa-ai-solutions/ontology-runtime'
import { ontologyExecutors } from './executors.js'

const ctx = { tenantId: 't1', actor: 'analyst' }
const prov = { source_ref: 'intake', confirmed_by: 'analyst', confirmed_at: '2026-06-01T00:00:00.000Z' }

// ── DECLARATIONS (what an app ships) ─────────────────────────────────────────
const ontologyDecl = {
  entities: [
    { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' as const }] },
    { name: 'document', label: 'Document', properties: [] },
  ],
  relationships: [{ name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N' as const, directed: true }],
}
const rulesDecl = {
  rules: [{ id: 'R-PROOF', kind: 'REQUIRED_RELATION' as const, appliesTo: 'invoice', condition: { op: 'absent' as const, relationship: 'proves' }, message: 'Invoice {id} lacks proof.', severity: 'HIGH', onFail: { action: 'requestDocument' } }],
}
const workflow: WorkflowV3 = {
  name: 'review', version: 3, pipeline: [{ phase: 'onboarding' }],
  phases: { onboarding: { tasks: [
    { id: 'ingest', type: 'agent-task', uses: 'ingest', depends: [] },
    { id: 'screen', type: 'agent-task', uses: 'evaluate-rules', with: { entityTypes: ['invoice'] }, outputs: { flagged: { type: 'boolean' }, findings: { type: 'number' } }, depends: ['ingest'] },
    { id: 'signoff', type: 'gate', 'gate-type': 'approval', description: 'sign off', depends: ['screen'], when: 'screen.flagged == true' },
    { id: 'report', type: 'agent-task', uses: 'report', with: { entityTypes: ['invoice'], output: 'report.md' }, depends: ['screen'] },
  ] } },
} as unknown as WorkflowV3

let tmp: string
let projectDir: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'owf-'))
  projectDir = path.join(tmp, '.dqa', 'projects', 'demo')
  await fs.mkdirp(projectDir)
})
afterEach(async () => { await fs.remove(tmp) })

describe('engine drives a declarative ontology workflow', () => {
  it('loads app, drives ingest→screen→gate→report through executors', async () => {
    const audit: AuditRecord[] = []
    const port = new GovernedOntologyPort(createOntology({ adapter: new InMemoryAdapter() }), [auditInterceptor((r) => { audit.push(r) })])

    // install the app from DECLARATIONS (kernel loaders, not app code)
    await loadOntology(port, ontologyDecl, ctx)
    await loadRules(port, rulesDecl, ctx, { source_ref: 'app:test', confirmed_by: 'test' })

    // the case (data) arrives as the run input
    const caseInput = JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 100 } }, { type: 'invoice', props: { amount: 200 } }] })

    const gates: string[] = []
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', workflow), ontologyExecutors(port, ctx, prov))
    const res = await runner.run({ input: caseInput, onGate: (g) => { gates.push(g); return true } })

    expect(res.status).toBe('complete')
    expect(gates).toEqual(['signoff']) // both invoices unproven → flagged → gate surfaced
    // Ingest goes through the governed BULK door: ONE coarse audit entry for the
    // whole batch (not per-item), carrying the counts in params. Per-item audit
    // is redundant for ingest (bulk-machine, pre-validated, deterministic).
    const ingestAudit = audit.filter((a) => a.action === 'ingest')
    expect(ingestAudit).toHaveLength(1)
    expect(ingestAudit[0]?.params).toEqual({ instances: 2, links: 0 })

    const report = await fs.readFile(path.join(projectDir, 'report.md'), 'utf-8')
    expect(report).toContain('Total findings: 2')
    expect(report).toContain('R-PROOF')
  })

  it('clean case (proven invoice) → no findings → gate skipped', async () => {
    const port = new GovernedOntologyPort(createOntology({ adapter: new InMemoryAdapter() }), [])
    await loadOntology(port, ontologyDecl, ctx)
    await loadRules(port, rulesDecl, ctx)

    // an invoice WITH a proof edge (ref-aliased) → rule does not fire
    const caseInput = JSON.stringify({
      instances: [{ type: 'invoice', props: { amount: 1 }, ref: 'inv' }, { type: 'document', props: {}, ref: 'doc' }],
      links: [{ relationship: 'proves', from: 'inv', to: 'doc' }],
    })
    const gates: string[] = []
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', workflow), ontologyExecutors(port, ctx, prov))
    const res = await runner.run({ input: caseInput, onGate: (g) => { gates.push(g); return true } })

    expect(res.status).toBe('complete')
    expect(gates).toEqual([]) // gate skipped
    const report = await fs.readFile(path.join(projectDir, 'report.md'), 'utf-8')
    expect(report).toContain('No rules fired')
  })
})
