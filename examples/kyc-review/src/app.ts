// The dogfood, driven like a Claude Code session via FieldSession.
// Deterministic steps run inside the kernel; the harness loop below stands in
// for the session: it approves gates and, for an agent step, writes a stub
// output. In production the driver is `/dqa-fos:run` (Claude dispatches a
// real subagent for the skill) — see the run we did live.

import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { FieldSession, type Checkpoint } from '@dqa-ai-solutions/agent-runtime'
import type { IngestPayload } from '@dqa-ai-solutions/agent-runtime'

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app')
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

export interface KycCase { name: string; ingest: IngestPayload }
export interface CaseOutcome { name: string; status: string; gateApproved: boolean; agentSteps: number; report: string }

export async function runCase(c: KycCase): Promise<CaseOutcome> {
  const tenant = slug(c.name)
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kyc-'))
  await fs.mkdirp(path.join(workspace, '.dqa', 'projects', tenant))
  const session = await FieldSession.open({ appDir, workspace, ruleDefaults: { source_ref: 'app:kyc', confirmed_by: 'compliance' } })

  let cp: Checkpoint = await session.start(tenant, JSON.stringify(c.ingest))
  let gateApproved = false
  let agentSteps = 0
  for (let i = 0; i < 50; i++) {
    if (cp.status === 'agent') {
      agentSteps++
      // Stub for the skill's subagent (production: /dqa-fos:run dispatches a real one).
      const out = cp.output ?? `${cp.task}.md`
      await fs.writeFile(path.join(workspace, '.dqa', 'projects', tenant, out), `# ${cp.task} (stub)\n\nrisk: HIGH (placeholder — a Claude Code session runs the skill via a subagent)\n`)
      cp = await session.done(tenant, cp.task)
    } else if (cp.status === 'waiting') {
      gateApproved = true
      cp = await session.approve(tenant, cp.gate)
    } else break
  }

  const report = cp.status === 'complete' ? cp.report : ''
  await fs.remove(workspace)
  return { name: c.name, status: cp.status, gateApproved, agentSteps, report }
}

export const cases: KycCase[] = [
  {
    name: 'Shell Holdings Ltd',
    ingest: {
      instances: [
        { type: 'customer', ref: 'c', props: { name: 'Shell Holdings Ltd', country: 'KY', pep: 'yes' } },
        { type: 'account', ref: 'a', props: { ref: 'ACC-9001' } },
        { type: 'transaction', props: { customer: 'Shell Holdings Ltd', amount: 20000000, day: '2026-06-01' } },
        { type: 'transaction', props: { customer: 'Shell Holdings Ltd', amount: 25000000, day: '2026-06-02' } },
        { type: 'transaction', props: { customer: 'Shell Holdings Ltd', amount: 25000000, day: '2026-06-03' } },
      ],
      links: [{ relationship: 'owns', from: 'c', to: 'a' }],
    },
  },
  {
    name: 'Acme Trading Co',
    ingest: {
      instances: [
        { type: 'customer', ref: 'c', props: { name: 'Acme Trading Co', country: 'VN', pep: 'no' } },
        { type: 'account', ref: 'a', props: { ref: 'ACC-1001' } },
        { type: 'kyc_doc', ref: 'd1', props: { kind: 'passport' } },
        { type: 'kyc_doc', ref: 'd2', props: { kind: 'utility-bill' } },
        { type: 'transaction', props: { customer: 'Acme Trading Co', amount: 5000000, day: '2026-06-01' } },
      ],
      links: [
        { relationship: 'owns', from: 'c', to: 'a' },
        { relationship: 'submitted', from: 'c', to: 'd1' },
        { relationship: 'submitted', from: 'c', to: 'd2' },
      ],
    },
  },
]
