// fuel-review dogfood driver — drives a COMPLETE FieldSession run end-to-end.
// Deterministic steps (ingest, check) and the sign-off gate are driven by the
// kernel. At the `investigate` checkpoint this acts as the Claude Code agent:
// it reads the flagged GiaoDich and, for each, uses the command-set (the same
// dqa-fos surface) to probe (reconDelta, laMayPhat) and decide — emit a CoDo
// (real problem, governed write) or note it (known exception). One loop, the
// agent's; the workflow is just the map the kernel walks.

import { FieldSession, CommandSet } from '@dqa-ai-solutions/agent-runtime'

/** A realistic period: g1 fuel-no-log (real) · g2 fuel-with-log (clean, 10%)
 *  · g4 fuel-no-log but a generator voucher (exception) · g3 not fuel. */
export const CASE = JSON.stringify({
  instances: [
    { type: 'GiaoDich', props: { amount: 5_000_000, category: 'xăng' }, ref: 'g1' },
    { type: 'GiaoDich', props: { amount: 1_500_000, category: 'xăng' }, ref: 'g2' },
    { type: 'NhatKyXe', props: { km: 500 }, ref: 'log2' },
    { type: 'GiaoDich', props: { amount: 4_000_000, category: 'xăng' }, ref: 'g4' },
    { type: 'ChungTu', props: { purpose: 'máy phát điện' }, ref: 'ct4' },
    { type: 'GiaoDich', props: { amount: 2_000_000, category: 'tiếp khách' }, ref: 'g3' },
  ],
  links: [
    { relationship: 'giaoDich_log', from: 'g2', to: 'log2' },
    { relationship: 'giaoDich_chungTu', from: 'g4', to: 'ct4' },
  ],
})

export interface DogfoodResult {
  decisions: Array<{ id: string; action: 'emitCoDo' | 'note'; delta: number }>
  coDoCount: number
  status: string
}

export async function runFuelDogfood(opts: {
  appDir: string
  workspace: string
  tenant: string
  caseJson: string
  log?: (msg: string) => void
}): Promise<DogfoodResult> {
  const log = opts.log ?? (() => {})
  const { appDir, workspace, tenant } = opts
  const session = await FieldSession.open({ appDir, workspace })

  const decisions: DogfoodResult['decisions'] = []
  let cp = await session.start(tenant, opts.caseJson)
  log(`▶ start → ${cp.status} (ingest + check chạy tất định)`)

  for (let i = 0; i < 100; i++) {
    if (cp.status === 'agent') {
      const flaggedIds = ((await session.status(tenant)).exports.flaggedIds as string[]) ?? []
      log(`\n🔎 [${cp.task}] tools=[${(cp.tools ?? []).join(', ')}] · ${flaggedIds.length} ca bị flag`)
      // Acts as Claude Code: the ONLY door to the ontology is the command-set.
      const cs = await CommandSet.open({ appDir, workspace, tenant, actor: 'senior' })
      for (const id of flaggedIds) {
        const delta = Number(await cs.call('reconDelta', { id }))
        const exception = Boolean(await cs.call('laMayPhat', { id }))
        if (!exception) {
          await cs.act('emitCoDo', { giaoDich: id, lyDo: `Chi xăng bất thường (lệch ${delta}đ), không ngoại lệ` })
          decisions.push({ id, action: 'emitCoDo', delta })
          log(`   • ${id}: lệch ${delta}đ, không ngoại lệ → PHÁT CỜ ĐỎ`)
        } else {
          await cs.note(id, 'đã xem xét, hợp lệ — xăng máy phát điện')
          decisions.push({ id, action: 'note', delta })
          log(`   • ${id}: ngoại lệ máy phát điện → ghi nhận hợp lệ`)
        }
      }
      const coDo = decisions.filter((d) => d.action === 'emitCoDo').length
      cp = await session.done(tenant, cp.task, { investigated: flaggedIds.length, coDo })
    } else if (cp.status === 'waiting') {
      log(`\n✋ [gate ${cp.gate}] ${cp.description} → senior2 duyệt`)
      cp = await session.approve(tenant, cp.gate)
    } else {
      break
    }
  }
  log(`\n✅ ${cp.status}`)

  const cs = await CommandSet.open({ appDir, workspace, tenant, actor: 'senior' })
  const coDoCount = (await cs.query('CoDo')).length
  return { decisions, coDoCount, status: cp.status }
}
