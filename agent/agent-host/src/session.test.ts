import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import { FieldSession } from './session.js'

let appDir: string
let workspace: string

const ontology = {
  entities: [
    { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' }] },
    { name: 'document', label: 'Document', properties: [] },
  ],
  relationships: [{ name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true }],
}
const rules = { rules: [{ id: 'R-PROOF', kind: 'REQUIRED_RELATION', appliesTo: 'invoice', condition: { op: 'absent', relationship: 'proves' }, message: 'Invoice {id} lacks proof.', severity: 'HIGH' }] }
const workflow = {
  name: 'review', version: 3, pipeline: [{ phase: 'p' }],
  phases: { p: { tasks: [
    { id: 'map', type: 'agent-task', uses: 'ingest', depends: [] },
    { id: 'screen', type: 'agent-task', uses: 'evaluate-rules', with: { entityTypes: ['invoice'] }, outputs: { flagged: { type: 'boolean' }, findings: { type: 'number' } }, depends: ['map'] },
    { id: 'gate', type: 'gate', 'gate-type': 'approval', description: 'sign off', depends: ['screen'], when: 'screen.flagged == true' },
    { id: 'decide', type: 'agent-task', uses: 'report', with: { entityTypes: ['invoice'], output: 'decision.md' }, depends: ['screen'] },
  ] } },
}

beforeEach(async () => {
  appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-'))
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-'))
  await fs.mkdirp(path.join(workspace, '.dqa', 'projects', 'acme'))
  await fs.writeJson(path.join(appDir, 'ontology.json'), ontology)
  await fs.writeJson(path.join(appDir, 'rules.json'), rules)
  await fs.writeJson(path.join(appDir, 'workflow.json'), workflow)
})
afterEach(async () => { await fs.remove(appDir); await fs.remove(workspace) })

describe('FieldSession — interactive, resumable run (the Claude-Code-session model)', () => {
  it('start auto-runs deterministic steps and STOPS at the gate; approve resumes to complete', async () => {
    const s1 = await FieldSession.open({ appDir, workspace })
    const cp1 = await s1.start('acme', JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }, { type: 'invoice', props: { amount: 2 } }] }))

    expect(cp1.status).toBe('waiting') // ingest + screen ran automatically; stopped at the gate
    expect(cp1.status === 'waiting' && cp1.gate).toBe('gate')

    // a SEPARATE session (simulating a new CLI process) resumes via the persisted
    // workflow state + filesystem ontology — proves cross-invocation continuity
    const s2 = await FieldSession.open({ appDir, workspace })
    const cp2 = await s2.approve('acme', 'gate')

    expect(cp2.status).toBe('complete')
    expect(cp2.status === 'complete' && cp2.report).toContain('Total findings: 2')
  })

  it('start is idempotent: re-invoking on an existing run RESUMES to the current checkpoint (never throws)', async () => {
    // A fresh Claude Code session's only move is `dqa-fos start`. The first call
    // starts the run and stops at the gate.
    const s1 = await FieldSession.open({ appDir, workspace })
    const cp1 = await s1.start('gamma', JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }, { type: 'invoice', props: { amount: 2 } }] }))
    expect(cp1.status).toBe('waiting')

    // A SEPARATE session re-runs `start` (it doesn't know a run already exists).
    // Old behavior threw "Workflow run already exists"; now it resumes to the
    // same pending gate.
    const s2 = await FieldSession.open({ appDir, workspace })
    const cp2 = await s2.start('gamma')
    expect(cp2.status).toBe('waiting')
    expect(cp2.status === 'waiting' && cp2.gate).toBe('gate')

    // Drive to completion, then `start` once more must report `complete`, not error.
    const cp3 = await s2.approve('gamma', 'gate')
    expect(cp3.status).toBe('complete')
    const s3 = await FieldSession.open({ appDir, workspace })
    const cp4 = await s3.start('gamma')
    expect(cp4.status).toBe('complete')
    expect(cp4.status === 'complete' && cp4.report).toContain('Total findings: 2')
  })

  it('clean case → no findings → gate skipped → complete on start', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    const cp = await s.start('beta', JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 9 }, ref: 'i' }, { type: 'document', props: {}, ref: 'd' }], links: [{ relationship: 'proves', from: 'i', to: 'd' }] }))
    expect(cp.status).toBe('complete')
    expect(cp.status === 'complete' && cp.report).toContain('No rules fired')
  })

  it('new-round clears the run (next start runs fresh) but keeps the graph', async () => {
    const tenant = 'round'
    const s = await FieldSession.open({ appDir, workspace })
    const cp = await s.start(tenant, JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 9 }, ref: 'i' }, { type: 'document', props: {}, ref: 'd' }], links: [{ relationship: 'proves', from: 'i', to: 'd' }] }))
    expect(cp.status).toBe('complete')

    const stateDir = path.join(workspace, '.dqa', 'state', tenant)
    expect(await fs.pathExists(stateDir)).toBe(true)
    // re-running start on a completed run just resumes → complete (the gap new-round closes)
    expect((await (await FieldSession.open({ appDir, workspace })).start(tenant)).status).toBe('complete')

    const r = await s.newRound(tenant)
    expect(r.kept).toContain('graph')
    expect(r.cleared).toContain('state')
    expect(await fs.pathExists(stateDir)).toBe(false) // run cleared so the next start is FRESH

    // a fresh start begins a NEW run over the SAME persistent graph (does not throw)
    const cp2 = await (await FieldSession.open({ appDir, workspace })).start(tenant)
    expect(['complete', 'waiting', 'agent']).toContain(cp2.status)
  })
})

// ── P1–P3: DANH TÍNH RUN + con trỏ run đã hoàn tất không giữ chỗ vĩnh viễn ──────────
// Bối cảnh: con trỏ run dùng CHUNG một slot mỗi tenant. Workflow B chạy sau ghi đè con
// trỏ của A ⇒ mọi `start --workflow A` resume B; B đã xong thì trả `complete` ngay và A
// KHÔNG BAO GIỜ chạy — caller chỉ thấy "complete" nên tưởng A xong. Lỗi này đã gây mất
// dữ liệu thật (một pha trích 34 task chỉ chạy 3 mà vẫn báo hoàn tất).
describe('run identity + finished-run pointer (P1–P3)', () => {
  // workflow thứ hai, tách biệt hẳn khỏi `review` ở trên
  const other = {
    name: 'other', version: 3, pipeline: [{ phase: 'q' }],
    phases: { q: { tasks: [{ id: 'solo', type: 'agent-task', uses: 'report', with: { entityTypes: ['invoice'], output: 'other.md' }, depends: [] }] } },
  }
  const writeOther = async () => fs.writeJson(path.join(appDir, 'workflow-other.json'), other)

  it('P2: mọi checkpoint mang workflow + resumed', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    const cp = await s.start('acme', JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }] }))
    expect(cp.workflow).toBe('review')
    expect(cp.resumed).toBe(false)          // lần đầu = khởi động mới
    const cp2 = await s.start('acme')       // gọi lại = tiếp run có sẵn
    expect(cp2.resumed).toBe(true)
    expect(cp2.workflow).toBe('review')
  })

  it('P1: status trả workflow + done/pending, GIỮ exports (tương thích ngược)', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    const none = await s.status('acme')
    expect(none).toMatchObject({ workflow: null, state: 'none' })

    await s.start('acme', JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }] }))
    const st = await s.status('acme')
    expect(st.workflow).toBe('review')
    expect(st.state).toBe('running')                 // đang dừng ở gate ⇒ chưa xong
    expect(st.done).toContain('map')                 // bước tất định đã chạy
    expect(st.pending.some((p) => p.task === 'gate')).toBe(true)
    expect(st.exports).toBeDefined()                 // khoá cũ còn nguyên
  })

})

// Nêu tên workflow ⇒ workflow đó có SỔ RIÊNG. Trước đây mọi workflow của một tenant dùng
// chung MỘT sổ + MỘT `_run.yaml`, mà marker chỉ khoá theo `task.id` — nguồn của cả lỗi
// NỐI TIẾP (run xong của B chặn A) lẫn ĐỒNG THỜI (dọn sổ giết việc nền đang chạy).
describe('cách ly sổ theo workflow (run isolation)', () => {
  const other = {
    name: 'other', version: 3, pipeline: [{ phase: 'q' }],
    phases: { q: { tasks: [{ id: 'solo', type: 'agent-task', uses: 'report', with: { entityTypes: ['invoice'], output: 'other.md' }, depends: [] }] } },
  }
  const writeOther = async () => fs.writeJson(path.join(appDir, 'workflow-other.json'), other)
  const stateRoot = () => path.join(workspace, '.dqa', 'state')
  const seed = JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }] })

  it('mỗi workflow một thư mục + một _run.yaml; sổ chung kiểu cũ KHÔNG được tạo', async () => {
    await writeOther()
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review')
    await s.start('acme', undefined, 'other')

    const dirs = (await fs.readdir(stateRoot())).sort()
    expect(dirs).toEqual(['acme--other', 'acme--review'])
    expect(await fs.pathExists(path.join(stateRoot(), 'acme'))).toBe(false)
    for (const d of dirs) {
      expect(await fs.pathExists(path.join(stateRoot(), d, '_run.yaml'))).toBe(true)
    }
  })

  it('run ĐÃ XONG của B không còn chặn được A — A chạy thật, không nhận `complete` giả', async () => {
    await writeOther()
    const s = await FieldSession.open({ appDir, workspace })
    const a = await s.start('acme', undefined, 'other')
    expect(a.status).toBe('complete')                       // `other` xong

    const b = await s.start('acme', seed, 'review')          // đây là ca gây mất dữ liệu ngày trước
    expect(b.workflow).toBe('review')
    expect(b.resumed).toBe(false)                            // KHỞI ĐỘNG MỚI, không phải resume nhầm B
    expect(b.status).toBe('waiting')                         // chạy thật tới gate
  })

  it('làm mới MỘT sổ không đụng sổ đang dở của workflow khác (ca #10: việc nền bị giết)', async () => {
    await writeOther()
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', undefined, 'other')                // ví việc nền: đã có tiến độ
    await s.start('acme', seed, 'review')

    await s.newRound('acme', undefined, 'review')            // người dùng bấm chạy lại `review`

    expect(await fs.pathExists(path.join(stateRoot(), 'acme--review'))).toBe(false)
    // tiến độ của workflow kia còn NGUYÊN — trước đây bước này xoá luôn của nó
    expect((await s.status('acme', 'other')).done).toContain('solo')
  })

  it('CÓ GHI mà không nêu sổ nào trên tenant đã tách → NÉM LỖI, tuyệt đối không đoán', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review')
    await expect(s.done('acme', 'map')).rejects.toThrow(/no run was selected/)
    await expect(s.newRound('acme')).rejects.toThrow(/no run was selected/)
  })

  it('DQA_RUN thay được cờ — mọi lệnh con trong một phiên tự trỏ đúng sổ', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review')
    process.env['DQA_RUN'] = 'review'
    try {
      expect((await s.status('acme')).workflow).toBe('review')   // không cần truyền cờ
    } finally {
      delete process.env['DQA_RUN']
    }
  })

  it('status không nêu sổ = CHỈ ĐỌC nên tóm tắt MỌI sổ thay vì ném lỗi', async () => {
    await writeOther()
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review')
    await s.start('acme', undefined, 'other')

    const all = await s.status('acme')
    expect(all.runs?.map((r) => r.run).sort()).toEqual(['other', 'review'])
    expect(all.runs?.find((r) => r.run === 'other')?.state).toBe('complete')
    expect(all.runs?.find((r) => r.run === 'review')?.state).toBe('running')
    expect(all.exports).toEqual({})                             // khoá cũ vẫn có, mã cũ không vỡ
  })

  it('KHÔNG nêu workflow ⇒ vẫn dùng sổ chung kiểu cũ (app một-workflow không phải sửa gì)', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('legacy', seed)                               // như app-builder / ví dụ mẫu
    expect(await fs.pathExists(path.join(stateRoot(), 'legacy', '_run.yaml'))).toBe(true)
    expect((await s.status('legacy')).workflow).toBe('review')
    await expect(s.done('legacy', 'map')).resolves.toBeDefined() // ghi được, không cần cờ
  })

  it('reset quét MỌI sổ của tenant, không sót sổ theo run', async () => {
    await writeOther()
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review')
    await s.start('acme', undefined, 'other')

    await s.reset('acme')
    const left = (await fs.readdir(stateRoot()).catch(() => [])).filter((d) => d.startsWith('acme'))
    expect(left).toEqual([])
  })

  it('khoá run bẩn bị chặn — không trèo ra ngoài .dqa/state', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await expect(s.start('acme', seed, '../escape')).rejects.toThrow(/invalid run key/)
  })
})

// Cách ly cắt được "workflow giẫm workflow". Còn lại: HAI TIẾN TRÌNH cùng lái MỘT sổ —
// chỉ xảy ra khi chạy nhiều worker, và không có gì trong sổ nói ai đang cầm.
describe('sở hữu run (lease)', () => {
  const seed = JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }] })
  const leaseFile = () => path.join(workspace, '.dqa', 'state', 'acme--review', '_lease.yaml')

  it('không khai owner ⇒ KHÔNG giữ lease (app một-tiến-trình chạy y nguyên)', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review')
    expect(await fs.pathExists(leaseFile())).toBe(false)
    expect((await s.status('acme', 'review')).heldBy).toBeUndefined()
  })

  it('chủ khác mà lease CÒN TƯƠI ⇒ từ chối lái, và từ chối cả new-round', async () => {
    const a = await FieldSession.open({ appDir, workspace, owner: 'worker-A' })
    await a.start('acme', seed, 'review')
    expect(await fs.pathExists(leaseFile())).toBe(true)

    const b = await FieldSession.open({ appDir, workspace, owner: 'worker-B' })
    await expect(b.start('acme', seed, 'review')).rejects.toThrow(/is held by "worker-A"/)
    await expect(b.done('acme', 'map', undefined, undefined, 'review')).rejects.toThrow(/is held by "worker-A"/)
    // ⭐ ca #10: dọn sổ của việc đang chạy dở phải bị CHẶN, không phải im lặng xoá
    await expect(b.newRound('acme', undefined, 'review')).rejects.toThrow(/is held by "worker-A"/)
    expect(await fs.pathExists(path.join(workspace, '.dqa', 'state', 'acme--review'))).toBe(true)
  })

  it('chính chủ luôn lái tiếp được, và lease được gia hạn', async () => {
    const a = await FieldSession.open({ appDir, workspace, owner: 'worker-A' })
    await a.start('acme', seed, 'review')
    const t1 = (await a.status('acme', 'review')).heldBy?.at
    await new Promise((r) => setTimeout(r, 5))
    await a.start('acme', undefined, 'review')
    const t2 = (await a.status('acme', 'review')).heldBy?.at
    expect(t2).not.toBe(t1)
  })

  it('lease QUÁ HẠN ⇒ chủ khác tiếp quản được — đây là cách phát hiện run CHẾT', async () => {
    const a = await FieldSession.open({ appDir, workspace, owner: 'worker-A' })
    await a.start('acme', seed, 'review')

    // ttl = 0 ⇒ mọi lease đều quá hạn
    const b = await FieldSession.open({ appDir, workspace, owner: 'worker-B', leaseTtlMs: 0 })
    const st = await b.status('acme', 'review')
    expect(st.heldBy?.owner).toBe('worker-A')
    expect(st.heldBy?.stale).toBe(true)              // nhìn thấy được là đã chết
    await expect(b.start('acme', undefined, 'review')).resolves.toBeDefined()
    expect((await b.status('acme', 'review')).heldBy?.owner).toBe('worker-B')
  })

  it('lease KHÔNG lọt vào sổ sự kiện — status vẫn đọc đúng tiến độ', async () => {
    const a = await FieldSession.open({ appDir, workspace, owner: 'worker-A' })
    await a.start('acme', seed, 'review')
    const st = await a.status('acme', 'review')
    expect(st.done).toContain('map')                 // không bị `_lease.yaml` làm nhiễu
    expect(st.done).not.toContain('_lease')
  })
})

// Cách ly theo WORKFLOW cắt được "workflow giẫm workflow", nhưng chưa cắt được "LẦN CHẠY giẫm
// lần chạy": hai lô của CÙNG một workflow vẫn phải chung sổ vì tên sổ = tên workflow. Khoá `run`
// tách khỏi tên workflow là chỗ cắt nốt.
describe('khoá run tách khỏi tên workflow (một workflow, nhiều lần chạy song song)', () => {
  const seed = JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }] })
  const stateRoot = () => path.join(workspace, '.dqa', 'state')

  it('hai lô CÙNG workflow, hai khoá run ⇒ hai sổ riêng, không đứa nào xoá sổ đứa nào', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    const a = await s.start('acme', seed, 'review', 'review.job-1')
    const b = await s.start('acme', seed, 'review', 'review.job-2')

    expect(a.workflow).toBe('review')
    expect(b.workflow).toBe('review')
    expect((await fs.readdir(stateRoot())).sort()).toEqual(['acme--review.job-1', 'acme--review.job-2'])

    // ĐÂY là ca đã gây hỏng câm ở app kế toán: lô sau `new-round` xoá sổ lô trước đang ghi.
    await s.newRound('acme', undefined, undefined, 'review.job-2')
    expect(await fs.pathExists(path.join(stateRoot(), 'acme--review.job-2'))).toBe(false)
    expect((await s.status('acme', undefined, 'review.job-1')).done).toContain('map')
  })

  it('sổ tự đặt tên + khởi động MỚI mà không nêu workflow ⇒ lỗi chỉ đúng chỗ', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await expect(s.start('acme', seed, undefined, 'job-x')).rejects.toThrow(/needs a workflow/)
  })

  it('resume chỉ cần khoá run — workflow lấy từ _run.yaml, không phải nêu lại', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review', 'review.job-1')
    expect((await s.status('acme', undefined, 'review.job-1')).workflow).toBe('review')

    const cp = await s.approve('acme', 'gate', undefined, undefined, 'review.job-1')
    expect(cp.status).toBe('complete')
    expect(cp.workflow).toBe('review')
  })

  it('DQA_RUN (sổ của PHIÊN) thắng --workflow — phiên của job không mở nhầm sổ mang tên workflow', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review', 'review.job-1')

    // Không có env: hỏi sổ tên `review` ⇒ chưa hề có sổ nào tên thế
    expect((await s.status('acme', 'review')).state).toBe('none')

    process.env['DQA_RUN'] = 'review.job-1'
    try {
      // Có env: cùng lời gọi ấy phải trỏ về sổ của JOB, dù `--workflow` vẫn được truyền
      const st = await s.status('acme', 'review')
      expect(st.state).toBe('running')
      expect(st.workflow).toBe('review')
    } finally {
      delete process.env['DQA_RUN']
    }
  })

  it('drop-run bỏ ĐÚNG một sổ, sổ của lô kia còn nguyên', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review', 'review.job-1')
    await s.start('acme', seed, 'review', 'review.job-2')

    expect(await s.dropRun('acme', 'review.job-1')).toEqual({ dropped: true })
    expect(await s.dropRun('acme', 'review.job-1')).toEqual({ dropped: false })   // idempotent
    expect((await fs.readdir(stateRoot())).sort()).toEqual(['acme--review.job-2'])
  })
})

// Lease chỉ có ĐƯỜNG GHI thì nó tự vô hiệu hoá: run xong vẫn để lại tờ "đang có người lái" tới
// hết ttl, nên job kế tiếp buộc phải khai TRÙNG owner — mà trùng owner thì lease không còn phân
// biệt được hai người lái, đúng ca duy nhất nó sinh ra để bắt.
describe('nhả lease (run xong thì trả sổ)', () => {
  const seed = JSON.stringify({ instances: [{ type: 'invoice', props: { amount: 1 } }] })
  const leaseFile = (run = 'review') => path.join(workspace, '.dqa', 'state', `acme--${run}`, '_lease.yaml')

  it('chạy tới complete ⇒ lease được nhả, job SAU vào ngay với owner RIÊNG (không chờ hết ttl)', async () => {
    const a = await FieldSession.open({ appDir, workspace, owner: 'worker-1:job-A' })
    await a.start('acme', seed, 'review', 'review.job-A')
    expect(await fs.pathExists(leaseFile('review.job-A'))).toBe(true)

    const done = await a.approve('acme', 'gate', undefined, undefined, 'review.job-A')
    expect(done.status).toBe('complete')
    expect(await fs.pathExists(leaseFile('review.job-A'))).toBe(false)
    expect((await a.status('acme', undefined, 'review.job-A')).heldBy).toBeUndefined()

    // Trước khi có nhả lease, đây là chỗ ném "is held by worker-1:job-A" suốt 60 phút.
    const b = await FieldSession.open({ appDir, workspace, owner: 'worker-1:job-B' })
    await expect(b.newRound('acme', undefined, undefined, 'review.job-A')).resolves.toBeDefined()
  })

  it('release nhả tay khi bỏ dở — và KHÔNG nhả hộ lease của chủ khác', async () => {
    const a = await FieldSession.open({ appDir, workspace, owner: 'worker-A' })
    await a.start('acme', seed, 'review')

    const b = await FieldSession.open({ appDir, workspace, owner: 'worker-B' })
    expect(await b.release('acme', 'review')).toEqual({ released: false })   // không phải sổ của B
    expect(await fs.pathExists(leaseFile())).toBe(true)
    await expect(b.start('acme', seed, 'review')).rejects.toThrow(/is held by "worker-A"/)

    expect(await a.release('acme', 'review')).toEqual({ released: true })
    expect(await fs.pathExists(leaseFile())).toBe(false)
    await expect(b.start('acme', undefined, 'review')).resolves.toBeDefined()  // nay vào được
  })

  it('không khai owner ⇒ nhả lease là no-op (app một-tiến-trình không đổi hành vi)', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme', seed, 'review')
    expect(await s.release('acme', 'review')).toEqual({ released: false })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE RUN'S INPUT MUST REACH EVERY EXECUTOR — not just the ones `start` happens to run.
//
// `drive()` hands `input` to each executor. `start` passed it; `done`/`approve` did not. Any workflow
// with a skill step runs MOST of its executors from a `done` call, so in practice the input was missing
// exactly where apps rely on it.
//
// Cost measured on a real client (a real deployment, Q1/2026): the payroll extractor reads `asOf`
// from the run input to keep only months inside the review period. Driven from `done` it kept ALL months —
// 1,550 `SocialInsurance` rows spanning 9 months in a 3-month period's namespace, where 662 is correct.
// Nothing threw; the denominator simply lied.
describe('run input reaches executors in EVERY continuation (start · done · approve)', () => {
  /** An app whose executor records the `input` it was handed, with an agent step in front of it. */
  const withRecorder = async (): Promise<string> => {
    const seen = path.join(workspace, 'seen.json')
    await fs.mkdirp(path.join(appDir, 'executors'))
    await fs.writeFile(
      path.join(appDir, 'executors', 'record-input.js'),
      `import fs from 'fs-extra'
export default { async run(sc) {
  const prev = await fs.readJson(${JSON.stringify(seen)}).catch(() => [])
  prev.push(sc.input ?? null)
  await fs.writeJson(${JSON.stringify(seen)}, prev)
  return { exports: { sawInput: sc.input ?? null } }
} }`,
    )
    await fs.writeJson(path.join(appDir, 'workflow.json'), {
      name: 'review', version: 3, pipeline: [{ phase: 'p' }],
      phases: { p: { tasks: [
        // No `uses` ⇒ the session must hand this one to the agent and wait for `done`.
        // `instruction` inline so the test needs no content server.
        { id: 'read-by-agent', type: 'agent-task', instruction: 'read the payroll workbook', depends: [] },
        { id: 'after-agent', type: 'agent-task', uses: 'record-input', depends: ['read-by-agent'] },
      ] } },
    })
    return seen
  }

  it('⚠ executor running AFTER an agent step still sees the run input', async () => {
    const seen = await withRecorder()
    const s = await FieldSession.open({ appDir, workspace })
    const cp = await s.start('acme', JSON.stringify({ asOf: '2026-03-31' }))
    expect(cp.status, 'must stop at the agent step').toBe('agent')

    await s.done('acme', 'read-by-agent', { ok: true })
    const recorded = await fs.readJson(seen)
    expect(recorded).toHaveLength(1)
    expect(JSON.parse(recorded[0])).toEqual({ asOf: '2026-03-31' })
  })

  it('no input on the run ⇒ executor sees undefined (no invention)', async () => {
    const seen = await withRecorder()
    const s = await FieldSession.open({ appDir, workspace })
    await s.start('acme')
    await s.done('acme', 'read-by-agent', { ok: true })
    expect(await fs.readJson(seen)).toEqual([null])
  })
})
