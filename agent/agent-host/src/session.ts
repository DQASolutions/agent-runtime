// FieldSession — the INTERACTIVE runtime, the way the system runs inside a
// Claude Code session. Unlike FieldApp (headless, one call), a session is
// resumable across separate CLI invocations: deterministic `uses:` steps run
// automatically; the drive STOPS and surfaces a checkpoint at a gate (human
// sign-off) or an agent step (a skill the session executes via a subagent).
//
// Persistence across invocations: the workflow state is event-sourced by the
// engine; the ontology uses the FilesystemAdapter so instances/rules survive
// between `dqa-fos start` and `dqa-fos approve`.
//
// MANY workflows per app: an app may ship several `app/workflow*.yaml`, each
// with its own `name:`. `start --workflow <name>` selects one; the chosen name
// is persisted by the orchestrator into `_run.yaml`, so `done`/`approve`/
// `status` resume the SAME workflow without re-passing it. No `--workflow` ⇒
// the file literally named `workflow.yaml` (back-compatible default).
//
// MỘT SỔ CHO MỖI LẦN CHẠY (khoá `run`). Nêu tên workflow ⇒ ghi vào SỔ RIÊNG
// `state/<tenant>--<workflow>/`; nêu `--run <key>` ⇒ sổ `state/<tenant>--<key>` (danh tính
// LẦN CHẠY, không phải tên công thức — nhờ đó MỘT workflow chạy được nhiều lần SONG SONG,
// mỗi lần một sổ); không nêu gì ⇒ sổ chung kiểu cũ `state/<tenant>/`. Trước đây
// MỌI workflow của một tenant dùng chung MỘT sổ và MỘT `_run.yaml`, mà marker chỉ khoá theo
// `task.id` (không mang tên workflow) — nên workflow này đọc nhầm dấu vết của workflow kia,
// và workflow chạy sau ghi đè con trỏ của workflow trước. Hai lỗi đã đo được ở app kế toán:
//   · NỐI TIẾP  — run đã xong của B còn giữ chỗ ⇒ A `start` lại resume B ⇒ trả `complete`
//                 ngay ⇒ A KHÔNG BAO GIỜ chạy (pha trích 34 task chỉ chạy 3, vẫn báo xong).
//   · ĐỒNG THỜI — lệnh người dùng dọn sổ để chạy tươi ⇒ xoá mất `_run.yaml` của việc nền
//                 đang chạy dở ⇒ việc nền chết giữa chừng.
// Cách ly theo `run` cắt cả hai TỪ GỐC: mỗi workflow một con trỏ, một sổ. Máy điều phối ở
// `@dqa-ai-solutions/agent-orchestrator` KHÔNG đổi một dòng — nó vốn đã nhận `run`; chỗ thiếu chỉ là fieldos
// chưa bao giờ truyền xuống.

import fs from 'fs-extra'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  Orchestrator,
  loadState,
  getStateDir,
  type WorkflowV3,
  type NextResult,
  type NextTaskPayload,
  type ExecutorRegistry,
} from '@dqa-ai-solutions/agent-orchestrator'
import { createOntology, type Ontology, type Ctx, type Provenance } from '@dqa-ai-solutions/ontology-runtime'
import { GovernedOntologyPort, rbacInterceptor, auditInterceptor, type AuditRecord } from '@dqa-ai-solutions/ontology-runtime'
import { loadOntology, loadRules, type OntologyDecl, type RulesDecl } from '@dqa-ai-solutions/ontology-runtime'
import { loadSkills, ontologyExecutors, checkExecutor, evalFindings, functionIO } from '@dqa-ai-solutions/agent-steps'
import { loadFunctions, type RulesByType } from '@dqa-ai-solutions/ontology-runtime'
import { readAppDecl } from './load-app.js'
import { loadAppExecutors, type AppExecutorIO } from '@dqa-ai-solutions/agent-steps'
import { parseSkill } from './skill-frontmatter.js'
import { buildStorage, type AppManifest } from '@dqa-ai-solutions/ontology-runtime'
import { appendTrace, ledgerPath, type TraceKind } from './trace.js'
import { writeGrant } from './grant.js'

export interface SessionOptions {
  appDir: string
  /** Working directory holding .dqa/ (state) and the persistent ontology. */
  workspace: string
  ruleDefaults?: { source_ref?: string; confirmed_by?: string }
  rbac?: (action: string, ctx: Ctx) => boolean
  /**
   * AI ĐANG CẦM SỔ NÀY — token tuỳ caller đặt (id worker, id lệnh…). Có đặt ⇒ mọi thao tác
   * CÓ GHI lên một run sẽ giữ/gia hạn `_lease.yaml`; chủ khác mà lease còn tươi ⇒ TỪ CHỐI.
   * Bỏ trống ⇒ KHÔNG giữ lease (mặc định, giữ nguyên hành vi cũ cho app một-tiến-trình).
   * Env: `DQA_OWNER`.
   */
  owner?: string
  /**
   * Lease quá hạn bao lâu thì coi là CHẾT và cho chủ khác tiếp quản. Ngưỡng này phải LỚN HƠN
   * khoảng lặng dài nhất giữa hai lần gọi kernel — một bước AI có thể im 15' mà vẫn khoẻ, nên
   * đặt ngắn là cướp quyền của phiên đang sống. Caller biết trần thời gian của chính mình nên
   * chính caller phải đặt. Mặc định 60'. Env: `DQA_LEASE_TTL_MS`.
   */
  leaseTtlMs?: number
}

/** Ai đang lái một run. Nằm cạnh `_run.yaml`, KHÔNG lọt vào glob sự kiện của kernel. */
interface Lease {
  owner: string
  at: string
  workflow: string
}
const LEASE_FILE = '_lease.yaml'
const DEFAULT_LEASE_TTL_MS = 60 * 60_000

/**
 * DANH TÍNH RUN đi kèm MỌI checkpoint. Thiếu nó, caller xin workflow A mà nhận `complete`
 * của run B (đã xong từ trước, còn giữ con trỏ) thì KHÔNG có cách nào phân biệt "A vừa xong"
 * với "B xong từ đời nào, A chưa hề chạy" — đúng lỗi đã gây mất dữ liệu ở app kế toán:
 * pha trích 34 task chỉ chạy 3 mà vẫn báo hoàn tất.
 *   · `workflow` — workflow THỰC SỰ được drive (có thể khác cái caller xin khi resume).
 *   · `resumed`  — true nếu tiếp một run có sẵn, false nếu vừa khởi động run mới.
 */
export interface RunIdentity {
  workflow: string
  resumed: boolean
}

export type Checkpoint = RunIdentity &
  (
    | { status: 'waiting'; gate: string; description: string }
    | { status: 'agent'; task: string; instruction?: string; tools?: string[]; output?: string; sources?: string[] }
    /**
     * `complete` = the run reached the end of its pipeline. It does NOT mean every step succeeded.
     *
     * `failed` carries any step whose executor threw. Present only when non-empty, so a caller can test
     * truthiness — but a caller that ignores it records a clean run over a hole in the data, which is exactly
     * the silence this field exists to break.
     */
    | { status: 'complete'; report: string; failed?: Array<{ task: string; error: string }> }
    | { status: 'blocked'; detail: unknown }
  )

/** Trạng thái run cho `status` — mở đúng thứ `loadState()` của kernel vốn đã có.
 *  `exports` GIỮ NGUYÊN chỗ cũ nên mã đang đọc `.exports` không phải đổi. */
export interface RunStatus {
  /** Workflow của run hiện tại; null khi chưa có run nào. */
  workflow: string | null
  /** `unknown` = có run nhưng không tra được định nghĩa workflow để biết còn thiếu gì. */
  state: 'none' | 'running' | 'complete' | 'unknown'
  /** Task đã có sự kiện done/skipped. */
  done: string[]
  /** Task khai trong workflow mà chưa có sự kiện. Rỗng khi state='complete'. */
  pending: Array<{ phase: string; task: string }>
  exports: Record<string, unknown>
  /**
   * CHỈ có khi hỏi `status` cho cả tenant mà tenant có NHIỀU sổ theo run: tóm tắt từng sổ.
   * Khi đó các trường ngoài mang giá trị trung tính (`workflow: null`, `state: 'none'`,
   * `exports: {}`) để mã cũ đang đọc `.exports` không vỡ.
   */
  runs?: Array<{ run: string } & Omit<RunStatus, 'runs'>>
  /** Ai đang lái run này, nếu có giữ lease. `staleMs > 0` = quá hạn ⇒ nhiều khả năng đã chết. */
  heldBy?: { owner: string; at: string; ageMs: number; stale: boolean }
}

/**
 * Khoá `run` đi thẳng vào TÊN THƯ MỤC, và nguồn của nó là cờ CLI / biến môi trường —
 * tức đầu vào ngoài. Chặn mọi ký tự có thể trèo ra khỏi `.dqa/state/` (`/`, `..`, NUL).
 */
const RUN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * SỔ NÀO / CÔNG THỨC NÀO — hai câu hỏi KHÁC NHAU, trước đây bị trả lời bằng một chuỗi.
 *   · `workflow` — định nghĩa nào được chạy (`app/workflow*.yaml` khớp `name:`)
 *   · `run`      — quyển sổ nào ghi lần chạy này (`.dqa/state/<tenant>--<run>`)
 * Trộn hai thứ làm một nghĩa là HAI LẦN CHẠY của cùng một workflow buộc phải chung sổ: lần
 * sau `new-round` xoá sổ lần trước đang ghi, `status` đọc lẫn exports của nhau — hỏng câm.
 * Ai muốn chạy song song thì đặt `run` riêng cho từng lần (id job, id lệnh…); ai không quan
 * tâm thì bỏ trống, sổ mang tên workflow y như trước.
 */
export interface RunSelector {
  workflow?: string
  run?: string
}

const PROV: Provenance = { source_ref: 'session', confirmed_by: 'session', confirmed_at: '2026-01-01T00:00:00.000Z' }

export class FieldSession {
  /** Function-rules grouped by type (rebound each invocation), for `check`. */
  private rulesByType: RulesByType = {}

  private constructor(
    private readonly decls: { ontology: OntologyDecl; rules: RulesDecl; manifest: AppManifest },
    private readonly opts: SessionOptions,
  ) {}

  static async open(opts: SessionOptions): Promise<FieldSession> {
    const dir = opts.appDir
    // The workflow is NOT loaded here — it is resolved per call (by name on
    // start, from _run.yaml on resume), since an app may carry many workflows.
    return new FieldSession(
      {
        ontology: await readAppDecl<OntologyDecl>(dir, 'ontology'),
        rules: await readAppDecl<RulesDecl>(dir, 'rules', {}),
        manifest: await readAppDecl<AppManifest>(dir, 'app', {}),
      },
      opts,
    )
  }

  /**
   * Begin OR resume a run, returning the CURRENT checkpoint. `workflowName`
   * selects among the app's `workflow*.yaml` (default: workflow.yaml). `start` is
   * idempotent on purpose: a per-workflow slash command's first (and only) move
   * is `dqa-fos start`, so a fresh Claude Code session resuming an in-progress
   * run — or re-opening a finished one — would otherwise hit `initRun`'s "run
   * already exists" error with no recovery path (`status` only returns exports,
   * never the pending checkpoint). When `_run.yaml` already exists we skip
   * `orch.start` and re-derive the current checkpoint from the event log via
   * `orch.next()` — surfacing the pending agent/gate, replaying any pending
   * deterministic steps, reporting `complete`, or naming what's `blocked`. The
   * persisted workflow wins over an explicit `--workflow` on resume, so a
   * re-invocation can't accidentally drive a different workflow than the one the
   * run was started with.
   *
   * `runKey` tách SỔ khỏi CÔNG THỨC (xem RunSelector): cùng một workflow chạy được nhiều
   * lần SONG SONG, mỗi lần một sổ. Khởi động mới với sổ tự đặt thì phải nêu luôn
   * `workflowName` — sổ không còn tự khai nó chạy workflow nào nữa.
   */
  async start(tenant: string, input?: string, workflowName?: string, runKey?: string): Promise<Checkpoint> {
    const run = await this.resolveRun(tenant, { workflow: workflowName, run: runKey })
    const stateDir = getStateDir(this.opts.workspace, tenant, run)
    const runFile = path.join(stateDir, '_run.yaml')
    const resuming = await fs.pathExists(runFile)

    // GỠ Ở ĐÂY (trước là khối "lưu trữ con trỏ run đã xong"): sổ tách theo run nên run đã xong
    // của B không còn giữ chỗ của A. Lỗi nó từng vá (A `start` lại resume B ⇒ `complete` giả)
    // bị chặn TỪ CẤU TRÚC. Mã chết trên đường nhạy cảm là nợ, không phải lưới an toàn.

    // Sổ tự đặt tên + chưa mở ⇒ KHÔNG suy ra được workflow (khoá run nay là id job, không phải
    // tên workflow). Nói thẳng ở đây, đừng để `findWorkflow` ném "workflow <id job> not found"
    // — thông điệp đó chỉ vào sai chỗ, người đọc đi tìm file workflow không tồn tại.
    if (!resuming && !workflowName && run && run !== undefined && !(await this.hasWorkflowNamed(run))) {
      throw new Error(
        `fresh run "${run}" needs a workflow to drive — pass --workflow <name>. A run key names the ` +
          `LOG (one per job); it does not say which workflow definition to run.`,
      )
    }

    const workflow = await this.resolveWorkflow(tenant, resuming ? undefined : workflowName, run)
    await this.claimLease(tenant, stateDir, workflow.name)
    const { orch, port, ctx, queryEdges, close } = await this.context(tenant, workflow, run)
    try {
      if (resuming) {
        await this.log(tenant, 'step', 'resume')
        const res = await orch.next()
        return await this.finish(tenant, run, await this.drive(orch, port, ctx, queryEdges, workflow, res, input, true))
      }
      await this.log(tenant, 'step', 'start', input ? { input: true } : undefined)
      const res = await orch.start(input ? { input } : {})
      return await this.finish(tenant, run, await this.drive(orch, port, ctx, queryEdges, workflow, res, input, false))
    } finally {
      await close()
    }
  }

  /** Approve a gate and continue to the next checkpoint. `rationale` records WHY
   *  the approver decided — the human-holds-the-rules evidence in the ledger. */
  async approve(
    tenant: string,
    gate: string,
    rationale?: string,
    workflowName?: string,
    runKey?: string,
  ): Promise<Checkpoint> {
    const run = await this.resolveRun(tenant, { workflow: workflowName, run: runKey })
    const workflow = await this.resolveWorkflow(tenant, undefined, run)
    await this.claimLease(tenant, getStateDir(this.opts.workspace, tenant, run), workflow.name)
    const { orch, port, ctx, queryEdges, close } = await this.context(tenant, workflow, run)
    try {
      await this.log(tenant, 'gate', gate, { decision: 'approved' }, rationale)
      const res = await orch.approve(gate)
      return await this.finish(
        tenant, run,
        await this.drive(orch, port, ctx, queryEdges, workflow, res, await this.runInput(tenant, run), true),
      )
    } finally {
      await close()
    }
  }

  /** Record an agent step's result (the session executed its skill) and continue. */
  async done(
    tenant: string,
    task: string,
    exports?: Record<string, unknown>,
    rationale?: string,
    workflowName?: string,
    runKey?: string,
  ): Promise<Checkpoint> {
    const run = await this.resolveRun(tenant, { workflow: workflowName, run: runKey })
    const workflow = await this.resolveWorkflow(tenant, undefined, run)
    await this.claimLease(tenant, getStateDir(this.opts.workspace, tenant, run), workflow.name)
    const { orch, port, ctx, queryEdges, close } = await this.context(tenant, workflow, run)
    try {
      await this.log(tenant, 'step', task, exports ? { exports: Object.keys(exports) } : undefined, rationale)
      const res = await orch.done(task, exports ? { exports } : {})
      // Executors that run in this continuation get the run's ORIGINAL input (see `runInput`).
      return await this.finish(
        tenant, run,
        await this.drive(orch, port, ctx, queryEdges, workflow, res, await this.runInput(tenant, run), true),
      )
    } finally {
      await close()
    }
  }

  async status(tenant: string, workflowName?: string, runKey?: string): Promise<RunStatus> {
    // `status` CHỈ ĐỌC ⇒ không strict: mơ hồ thì tóm tắt mọi sổ, không ném lỗi. Nó phải
    // trả lời được "kỳ này đang có việc gì" mà caller KHÔNG cần biết trước tên workflow.
    const run = await this.resolveRun(tenant, { workflow: workflowName, run: runKey }, { strict: false })
    if (run === undefined) {
      const runs = await this.runDirsFor(tenant)
      if (runs.length > 0) {
        const each = await Promise.all(
          runs.map(async (r) => {
            const s = await this.statusOf(tenant, r)
            return { run: r, workflow: s.workflow, state: s.state, done: s.done, pending: s.pending, exports: s.exports }
          }),
        )
        return { workflow: null, state: 'none', done: [], pending: [], exports: {}, runs: each }
      }
    }
    return this.statusOf(tenant, run)
  }

  private async statusOf(tenant: string, run?: string): Promise<RunStatus> {
    const state = await loadState(getStateDir(this.opts.workspace, tenant, run)).catch(() => null)
    if (!state) return { workflow: null, state: 'none', done: [], pending: [], exports: {} }

    const workflowName = state.run.workflow
    // Task ĐÃ có sự kiện (done/skipped) — đọc thẳng sổ sự kiện, KHÔNG chạy orchestrator:
    // `next()` có tác dụng phụ (reconcileCompletions GHI sự kiện cho task cha), nên không
    // được dùng trong một lệnh chỉ-đọc.
    const settled = new Set(
      Object.entries(state.tasks)
        .filter(([, e]) => e.status === 'done' || e.status === 'skipped')
        .map(([id]) => id),
    )
    const done = [...settled].sort()

    // Task KHAI trong workflow mà chưa có sự kiện. Không tra được định nghĩa workflow
    // (đã đổi tên/gỡ đi) ⇒ pending = null: "không xác định được", KHÁC hẳn "rỗng".
    let pending: Array<{ phase: string; task: string }> | null = null
    try {
      const wf = await this.findWorkflow(workflowName)
      pending = []
      for (const [phase, body] of Object.entries(wf.phases ?? {})) {
        for (const t of (body as { tasks?: Array<{ id?: string }> })?.tasks ?? []) {
          if (t?.id && !settled.has(t.id)) pending.push({ phase, task: t.id })
        }
      }
    } catch {
      pending = null
    }

    const ttl = this.opts.leaseTtlMs ?? Number(process.env['DQA_LEASE_TTL_MS'] ?? DEFAULT_LEASE_TTL_MS)
    const lease = await fs
      .readFile(path.join(getStateDir(this.opts.workspace, tenant, run), LEASE_FILE), 'utf-8')
      .then((t) => yaml.load(t) as Lease | undefined)
      .catch(() => undefined)
    const ageMs = lease?.at ? Date.now() - new Date(lease.at).getTime() : 0

    return {
      workflow: workflowName,
      state: pending === null ? 'unknown' : pending.length === 0 ? 'complete' : 'running',
      done,
      pending: pending ?? [],
      exports: state.exports ?? {},
      ...(lease?.owner ? { heldBy: { owner: lease.owner, at: lease.at, ageMs, stale: ageMs >= ttl } } : {}),
    }
  }

  /**
   * DESTRUCTIVE reset — wipe a tenant's run so the next `start` loads from a
   * clean slate. Three things go:
   *   1. the ontology graph (adapter.clearTenant — instances/edges/rules/schema);
   *   2. the workflow state dir (the `.done.yaml` event log under .dqa/state);
   *   3. the case ledger is ARCHIVED (renamed to ledger.<ts>.bak), not deleted,
   *      so the audit trail of the discarded run is preserved.
   * The tenant's `sources/` and `_ingest/` artifacts are LEFT in place — they are
   * the inputs a fresh load reads. Use this to recover from a corrupted/duplicated
   * load, or to start a period over. Idempotent on an already-clean tenant.
   */
  async reset(tenant: string, at: string = new Date().toISOString()): Promise<{ cleared: string[] }> {
    const cleared: string[] = []

    // 1. Graph — re-scope the app's adapter to the tenant and clear it.
    const { adapter } = buildStorage(this.decls.manifest.storage, {
      workspace: this.opts.workspace,
      tenant,
    })
    try {
      await adapter.withTenant(tenant).clearTenant()
      cleared.push('graph')
    } finally {
      await adapter.close?.()
    }

    // 2. Workflow state (event-sourced run log). `reset` = ĐỐT CẢ TENANT, nên phải quét
    //    SỔ CHUNG kiểu cũ LẪN MỌI sổ theo run (`<tenant>--<workflow>`) — bỏ sót sổ theo run
    //    thì graph sạch mà dấu vết bước vẫn còn ⇒ lần start sau SKIP hết, không nạp lại gì.
    const runDirs = (await this.runDirsFor(tenant)).map((r) => getStateDir(this.opts.workspace, tenant, r))
    let wiped = 0
    for (const dir of [getStateDir(this.opts.workspace, tenant), ...runDirs]) {
      if (await fs.pathExists(dir)) {
        await fs.remove(dir)
        wiped++
      }
    }
    if (wiped > 0) cleared.push('state')

    // 3. Archive the ledger (keep the audit trail of the discarded run).
    const tenantDir = path.join(this.opts.workspace, '.dqa', 'projects', tenant)
    const lp = ledgerPath(tenantDir)
    if (await fs.pathExists(lp)) {
      await fs.move(lp, path.join(tenantDir, `ledger.${at.replace(/[:.]/g, '-')}.bak`))
      cleared.push('ledger(archived)')
    }

    return { cleared }
  }

  /**
   * NEW ROUND — clear a tenant's workflow run so the next `start` begins a FRESH run, while KEEPING
   * the ontology graph. This is `reset` minus the graph wipe: the captured data (instances/edges/
   * rules/schema) survives; only the run position is cleared and the ledger archived. Use it to
   * run a workflow again over the same knowledge base — e.g. a targeted `*-change` amendment after
   * a previous run finished. Idempotent on a tenant with no run.
   */
  async newRound(
    tenant: string,
    at: string = new Date().toISOString(),
    workflowName?: string,
    runKey?: string,
  ): Promise<{ cleared: string[]; kept: string[] }> {
    const cleared: string[] = []

    // MỘT SỔ, KHÔNG PHẢI CẢ TENANT. Đây là chỗ thay thế việc app tự `fs.remove` từng thư mục
    // phase: dọn đúng sổ của workflow này, các sổ khác KHÔNG bị đụng — nên việc nền đang chạy
    // dở (pha trích ngoài) giữ nguyên tiến độ dù người dùng bấm nạp/soát lại giữa chừng.
    // strict: mơ hồ thì NÉM LỖI — xoá nhầm sổ là mất tiến độ hàng chục phút, không hoàn tác được.
    const run = await this.resolveRun(tenant, { workflow: workflowName, run: runKey })
    const stateDir = getStateDir(this.opts.workspace, tenant, run)
    if (await fs.pathExists(stateDir)) {
      // Xoá sổ mà tiến trình KHÁC đang lái = giết nó giữa chừng — đúng chế độ hỏng đã gặp
      // (lệnh người dùng dọn state, việc nền mất `_run.yaml`, chết với "Workflow not started").
      await this.claimLease(tenant, stateDir, run ?? 'default')
      await fs.remove(stateDir)
      cleared.push('state')
    }

    // Archive the ledger (keep the finished round's audit trail; the new round starts clean).
    const tenantDir = path.join(this.opts.workspace, '.dqa', 'projects', tenant)
    const lp = ledgerPath(tenantDir)
    if (await fs.pathExists(lp)) {
      await fs.move(lp, path.join(tenantDir, `ledger.${at.replace(/[:.]/g, '-')}.bak`))
      cleared.push('ledger(archived)')
    }

    // The graph is deliberately LEFT intact — that is the whole point of a new round.
    return { cleared, kept: ['graph'] }
  }

  /**
   * NHẢ QUYỀN LÁI một run — xoá `_lease.yaml` nếu nó đang thuộc về TA.
   *
   * Kernel tự gọi khi run chạy tới `complete`; caller gọi tay khi bỏ dở (job bị huỷ, worker
   * tắt có trật tự). Không có nó thì lease chỉ có đường ghi: một run đã xong vẫn để lại tờ
   * "đang có người lái" cho tới hết TTL (mặc định 60'), nên job KẾ TIẾP trên cùng sổ buộc phải
   * khai TRÙNG owner với job trước — mà trùng owner thì lease không còn phân biệt được hai
   * tiến trình cùng lái, đúng ca duy nhất nó sinh ra để bắt.
   *
   * Nhả xong thì TTL quay về đúng một nghĩa: "chủ cũ CHẾT giữa chừng".
   * KHÔNG xoá lease của chủ khác — nhả hộ người khác là mở cửa cho đúng thứ ta đang chặn.
   */
  async release(tenant: string, workflowName?: string, runKey?: string): Promise<{ released: boolean }> {
    const run = await this.resolveRun(tenant, { workflow: workflowName, run: runKey })
    return { released: await this.releaseLease(tenant, run) }
  }

  /**
   * BỎ HẲN MỘT SỔ (giữ graph + ledger). Sổ theo JOB thì mỗi lần chạy đẻ một thư mục, nên phải
   * có đường dọn — khác `newRound` ở chỗ: newRound là "chạy lại vòng mới trên cùng sổ" (có lưu
   * trữ ledger), còn đây là "quyển sổ này xong việc rồi, cất đi". Chặn nếu chủ KHÁC đang lái.
   */
  async dropRun(tenant: string, runKey: string): Promise<{ dropped: boolean }> {
    const run = await this.resolveRun(tenant, { run: runKey })
    const stateDir = getStateDir(this.opts.workspace, tenant, run)
    if (!(await fs.pathExists(stateDir))) return { dropped: false }
    await this.claimLease(tenant, stateDir, run ?? 'default')
    await fs.remove(stateDir)
    return { dropped: true }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * GIỮ / GIA HẠN QUYỀN LÁI một run. Gọi trước MỌI thao tác có ghi (start · done · approve ·
   * new-round). Không cấu hình `owner` ⇒ no-op, giữ nguyên hành vi cũ.
   *
   * Cố ý KHÔNG dùng pid để đo "còn sống": mỗi lệnh `dqa-fos` là một tiến trình riêng, chết ngay
   * sau khi trả kết quả — pid của nó không đại diện cho phiên đang lái. Chủ sở hữu thật là thứ
   * ở TẦNG TRÊN (worker / phiên AI), nên chính nó phải tự khai token.
   *
   * Ba nhánh:
   *   · chưa có lease, hoặc chính ta                → ghi/gia hạn
   *   · chủ khác, lease CÒN TƯƠI                    → TỪ CHỐI (đây là ca hai tiến trình cùng lái)
   *   · chủ khác, lease QUÁ HẠN                     → tiếp quản, ghi vết vào ledger
   */
  private async claimLease(tenant: string, stateDir: string, workflow: string): Promise<void> {
    const owner = this.opts.owner ?? process.env['DQA_OWNER']
    if (!owner) return
    const ttl = this.opts.leaseTtlMs ?? Number(process.env['DQA_LEASE_TTL_MS'] ?? DEFAULT_LEASE_TTL_MS)
    const file = path.join(stateDir, LEASE_FILE)
    const cur = await fs
      .readFile(file, 'utf-8')
      .then((t) => yaml.load(t) as Lease | undefined)
      .catch(() => undefined)

    if (cur?.owner && cur.owner !== owner) {
      const ageMs = Date.now() - new Date(cur.at).getTime()
      if (Number.isFinite(ageMs) && ageMs < ttl) {
        throw new Error(
          `run "${path.basename(stateDir)}" is held by "${cur.owner}" (last seen ${Math.round(ageMs / 1000)}s ago, ` +
            `lease ttl ${Math.round(ttl / 1000)}s) — refusing to drive it from "${owner}". ` +
            `Two drivers on one run log interleave events and corrupt progress.`,
        )
      }
      // Quá hạn = chủ cũ chết giữa chừng. Đây chính là cơ chế PHÁT HIỆN RUN TREO mà trước
      // đây không có — trước kia con trỏ kẹt vĩnh viễn, không phân biệt được "đang chạy"
      // với "đã chết", nên việc nền cứ nhường lượt mãi và im lặng bỏ sót.
      await this.log(tenant, 'step', 'lease-taken-over', { from: cur.owner, to: owner, ageMs })
    }
    await fs.mkdirp(stateDir)
    await fs.writeFile(file, yaml.dump({ owner, at: new Date().toISOString(), workflow } satisfies Lease), 'utf-8')
  }

  /** Xoá `_lease.yaml` nếu nó đang thuộc về TA (xem `release`). Không khai owner ⇒ no-op. */
  private async releaseLease(tenant: string, run?: string): Promise<boolean> {
    const owner = this.opts.owner ?? process.env['DQA_OWNER']
    if (!owner) return false
    const file = path.join(getStateDir(this.opts.workspace, tenant, run), LEASE_FILE)
    const cur = await fs
      .readFile(file, 'utf-8')
      .then((t) => yaml.load(t) as Lease | undefined)
      .catch(() => undefined)
    if (!cur || cur.owner !== owner) return false
    await fs.remove(file)
    return true
  }

  /** Run vừa chạy tới `complete` ⇒ nhả sổ ngay, đừng bắt job sau chờ hết TTL. */
  private async finish(tenant: string, run: string | undefined, cp: Checkpoint): Promise<Checkpoint> {
    if (cp.status === 'complete') await this.releaseLease(tenant, run).catch(() => false)
    return cp
  }

  /** App có workflow mang đúng tên này không (dùng để phân biệt khoá run với tên workflow). */
  private async hasWorkflowNamed(name: string): Promise<boolean> {
    return this.findWorkflow(name).then(
      () => true,
      () => false,
    )
  }

  /** Tên các sổ theo run đang tồn tại của một tenant (`<tenant>--<run>`). */
  private async runDirsFor(tenant: string): Promise<string[]> {
    const root = path.join(this.opts.workspace, '.dqa', 'state')
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(`${tenant}--`))
      .map((e) => e.name.slice(tenant.length + 2))
      .sort()
  }

  /**
   * SỔ NÀO? — phân giải khoá `run` cho một lời gọi. `run` là DANH TÍNH LẦN CHẠY; mặc định
   * (không nêu `--run`) nó lấy tên workflow, nên app cũ không phải sửa gì.
   *
   * Thứ tự:
   *   1. `--run` tường minh, rồi `DQA_RUN`, rồi `--workflow` (bí danh) — xem khối trong thân hàm
   *   2. đã có sổ THEO RUN mà không biết sổ nào → tuỳ `strict`:
   *        · strict (start/done/approve/new-round — CÓ GHI) → NÉM LỖI.
   *          Đoán sai ở đây = ghi marker vào sổ không ai đọc ⇒ workflow treo vĩnh viễn,
   *          KHÔNG có triệu chứng. Thà chết ồn còn hơn sai câm.
   *        · không strict (`status` — CHỈ ĐỌC) → trả undefined để caller tóm tắt mọi sổ.
   *   3. còn lại → sổ chung kiểu cũ (app một-workflow chạy y nguyên, không phải sửa gì;
   *      `loadState` sẽ báo "chưa khởi động" nếu cũng chưa có).
   *
   * ⚠ Bước 2 phải đứng TRƯỚC bước 3: tenant đã di trú (có sổ theo run) thường vẫn còn sổ
   * chung cũ nằm đó. Nếu ưu tiên sổ cũ, một lời gọi lỡ thiếu `--run`/`--workflow`/env sẽ
   * ÂM THẦM ghi vào quyển đã bỏ — đúng chế độ hỏng ta đang đi diệt.
   */
  private async resolveRun(
    tenant: string,
    sel: RunSelector = {},
    opts: { strict?: boolean } = {},
  ): Promise<string | undefined> {
    // THỨ TỰ ƯU TIÊN — trong CÁC NGUỒN NÓI VỀ SỔ thì cờ thắng env; `--workflow` chỉ là bí danh
    // cuối cùng (di sản thời sổ mang tên workflow), KHÔNG phải một nguồn ngang hàng:
    //   1. `--run`      — nói thẳng "quyển sổ nào"
    //   2. `DQA_RUN`    — sổ của PHIÊN đang chạy; mọi lệnh con thừa kế qua env
    //   3. `--workflow` — bí danh tương thích ngược: không nêu sổ thì sổ mang tên workflow
    // (2) phải thắng (3): trong một phiên AI của job X, chính phiên đó gõ `start --workflow A`,
    // mà `--workflow` ở đó chọn ĐỊNH NGHĨA để chạy, không phải quyển sổ để ghi. Nếu để (3) thắng
    // thì phiên mở sổ mang tên A thay vì sổ của job X — đúng cái ta đang đi diệt.
    const named = sel.run ?? process.env['DQA_RUN'] ?? sel.workflow ?? undefined
    if (named) {
      if (!RUN_KEY_RE.test(named)) {
        throw new Error(`invalid run key "${named}" — allowed: letters, digits, dot, dash, underscore`)
      }
      return named
    }
    const runs = await this.runDirsFor(tenant)
    if (runs.length > 0 && opts.strict !== false) {
      throw new Error(
        `tenant "${tenant}" has per-run state (${runs.join(', ')}) but no run was selected — ` +
          `pass --run <key> (or --workflow <name>, or set DQA_RUN). Refusing to guess: writing to ` +
          `the wrong run log marks work done where nothing reads it.`,
      )
    }
    return undefined
  }

  /**
   * The run's ORIGINAL `--input`, as persisted into `_run.yaml` by `start`.
   *
   * ⚠️ WHY THIS EXISTS. `drive()` hands `input` to every executor it runs. `start` passed it, but
   * `done`/`approve` did not — so every executor that runs in the CONTINUATION after an agent step saw
   * `input === undefined`. That is the common case, not the corner case: any workflow with a skill step
   * runs most of its executors from a `done` call.
   *
   * Measured on a real client (a real deployment, Q1/2026): the extractor reads `asOf` from the run
   * input to keep only months inside the review period. Driven from `done`, it silently kept ALL months —
   * **1,550 `SocialInsurance` rows spanning 9 months landed in a 3-month period's namespace** (662 is the
   * correct number). Nothing failed; the denominator simply lied. An app can defend itself (that app now
   * also derives the period from its namespace), but the fix belongs here: the run's input is run-scoped
   * state, and the session already persists it.
   */
  private async runInput(tenant: string, run?: string): Promise<string | undefined> {
    const runFile = path.join(getStateDir(this.opts.workspace, tenant, run), '_run.yaml')
    const meta = await fs
      .readFile(runFile, 'utf-8')
      .then((t) => yaml.load(t) as { input?: unknown } | undefined)
      .catch(() => undefined)
    const v = meta?.input
    if (v === undefined || v === null) return undefined
    return typeof v === 'string' ? v : JSON.stringify(v)
  }

  /**
   * Resolve which workflow this call drives. Priority: an explicit name (only
   * meaningful on `start`) → the name the orchestrator persisted in `_run.yaml`
   * on start (so resume uses the SAME one) → the default `workflow.yaml`. The
   * chosen decl gets its skills bound before use.
   */
  private async resolveWorkflow(tenant: string, explicit?: string, run?: string): Promise<WorkflowV3> {
    let name = explicit
    if (!name) {
      // Read the workflow name the orchestrator persisted into _run.yaml on start.
      const runFile = path.join(getStateDir(this.opts.workspace, tenant, run), '_run.yaml')
      const meta = await fs
        .readFile(runFile, 'utf-8')
        .then((t) => yaml.load(t) as { workflow?: string } | undefined)
        .catch(() => undefined)
      name = meta?.workflow
    }
    // Sổ chưa mở (`_run.yaml` chưa có) mà khoá run trùng tên một workflow ⇒ đó là ca mặc định
    // (không nêu `--run`, sổ mang tên workflow): lấy chính nó, KHÔNG được rơi về `workflow.yaml`
    // mặc định vì như thế là lái nhầm sang workflow caller không hề xin. Còn sổ tự đặt tên
    // (id job) thì `start` đã đòi `--workflow` từ trước khi tới đây.
    if (!name) name = run
    const workflow = await this.findWorkflow(name)
    const skillsDir = path.join(this.opts.appDir, 'skills')
    if (await fs.pathExists(skillsDir)) await loadSkills(workflow, skillsDir)
    return workflow
  }

  /**
   * Find a workflow declaration in the app. No name → the file literally named
   * `workflow.{yaml,yml,json}`. A name → scan every `app/workflow*.{yaml,yml}`
   * and match on the decl's `name:` field.
   */
  private async findWorkflow(name?: string): Promise<WorkflowV3> {
    if (!name) return readAppDecl<WorkflowV3>(this.opts.appDir, 'workflow')
    const files = (await fs.readdir(this.opts.appDir)).filter((f) => /^workflow.*\.(ya?ml|json)$/.test(f)).sort()
    for (const f of files) {
      const decl = yaml.load(await fs.readFile(path.join(this.opts.appDir, f), 'utf-8')) as WorkflowV3 | undefined
      if (decl?.name === name) return decl
    }
    throw new Error(`workflow "${name}" not found in ${this.opts.appDir} (scanned: ${files.join(', ') || 'none'})`)
  }

  private async context(
    tenant: string,
    workflow: WorkflowV3,
    run?: string,
  ): Promise<{
    orch: Orchestrator
    port: GovernedOntologyPort
    ctx: Ctx
    queryEdges: AppExecutorIO['queryEdges']
    /** Release the storage backend's connection pool (Neo4j Bolt driver, pg Pool)
     *  so the CLI process can exit. No-op for the pool-less filesystem backend. */
    close: () => Promise<void>
  }> {
    const ctx: Ctx = { tenantId: tenant, actor: 'session' }
    const tenantDir = path.join(this.opts.workspace, '.dqa', 'projects', tenant)
    await fs.mkdirp(tenantDir)
    // Storage backend is the app's declaration (app.yaml → storage), mapped to
    // a concrete adapter by the kernel — not hardcoded here.
    const { adapter, provision } = buildStorage(this.decls.manifest.storage, {
      workspace: this.opts.workspace,
      tenant,
    })
    const ontology = createOntology({ adapter })
    await this.ensureInstalled(ontology, ctx, provision) // idempotent on the persistent store
    const port = new GovernedOntologyPort(ontology, [
      rbacInterceptor(this.opts.rbac ?? (() => true)),
      auditInterceptor((rec) => this.recordAct(tenantDir, tenant, rec)),
    ])
    // Read-only BULK edge read, tenant-scoped — one storage round-trip for ALL
    // edges of a relationship, so a perf-sensitive executor can avoid N per-node
    // neighbors() calls (vd duyệt 12k bút toán). The graph WRITE door stays the
    // governed port; this only reads.
    const tenantAdapter = adapter.withTenant(tenant)
    const queryEdges: AppExecutorIO['queryEdges'] = async (relationship) =>
      (await tenantAdapter.queryEdges({ relationship })).map((e) => ({ fromId: e.fromId, toId: e.toId }))
    // Closing the base adapter disposes the pool shared by every withTenant view.
    const close = async (): Promise<void> => {
      await adapter.close?.()
    }
    // ⭐ Tham số thứ 4 (`run`) — CHỖ DUY NHẤT quyết định workflow này ghi vào sổ nào.
    // Bỏ trống nó chính là nguyên nhân mọi workflow của một tenant dùng chung một sổ.
    const orch = new Orchestrator(this.opts.workspace, tenant, workflow, run)
    return { orch, port, ctx, queryEdges, close }
  }

  /** Append a workflow lifecycle entry to the case ledger. */
  private async log(
    tenant: string,
    kind: TraceKind,
    name: string,
    result?: unknown,
    rationale?: string,
  ): Promise<void> {
    await appendTrace(path.join(this.opts.workspace, '.dqa', 'projects', tenant), {
      tenant,
      actor: 'session',
      kind,
      name,
      ...(result !== undefined ? { result } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
    })
  }

  /** Append a governed write to the case ledger (Step 2 — full audit trail). */
  private async recordAct(tenantDir: string, tenant: string, rec: AuditRecord): Promise<void> {
    await appendTrace(tenantDir, {
      tenant,
      actor: rec.actor,
      kind: 'act',
      name: rec.action,
      ...(rec.params !== undefined ? { args: rec.params } : {}),
      result: { events: rec.events },
      ...(rec.provenance ? { provenance: rec.provenance } : {}),
    })
  }

  private async ensureInstalled(ontology: Ontology, ctx: Ctx, provision: boolean): Promise<void> {
    await loadOntology(ontology, this.decls.ontology, ctx) // in-memory schema registry — cheap, no conflict
    // Provision the backend's schema before any write. Required for postgres
    // (tables must exist); skipped for the schemaless filesystem/in-memory stores.
    if (provision) await ontology.migrate(ctx)
    await loadRules(ontology, this.decls.rules, ctx, { ...this.opts.ruleDefaults, skipExisting: true }) // install-if-absent on the persistent store
    // Function/Action bodies live in-memory on this (fresh-per-invocation)
    // ontology, so rebind every time; rulesByType feeds the `check` executor.
    // Layers: base `functions/` + any industry overlays the manifest declares
    // (override-by-id) — the seam for industry-specific rules without forking base.
    this.rulesByType = await loadFunctions(ontology, this.functionLayers(), ctx)
  }

  /** Base `functions/` + declared industry overlays (`app/overlays/<n>/functions`),
   *  in load order so overlays override the base by rule id. */
  private functionLayers(): string[] {
    const base = path.join(this.opts.appDir, 'functions')
    const overlays = (this.decls.manifest.overlays ?? []).map((n) => path.join(this.opts.appDir, 'overlays', n, 'functions'))
    return [base, ...overlays]
  }

  private async drive(
    orch: Orchestrator,
    port: GovernedOntologyPort,
    ctx: Ctx,
    queryEdges: AppExecutorIO['queryEdges'],
    workflow: WorkflowV3,
    start: NextResult,
    input?: string,
    // Danh tính run gắn vào MỌI checkpoint trả ra (xem RunIdentity).
    resumed = false,
  ): Promise<Checkpoint> {
    // Built-ins + the app's OWN executors (app/executors/*.js). App executors
    // are merged first so a built-in always wins a name clash. `findings` lets a
    // app report executor read the app's OWN function-rules (one eval path) —
    // so the rule, not the report, owns "what's wrong / by how much".
    const io = functionIO(port, ctx)
    const findings: AppExecutorIO['findings'] = (types) =>
      evalFindings(this.rulesByType, types ?? Object.keys(this.rulesByType), io)
    const app = await loadAppExecutors(this.opts.appDir, { port, ctx, prov: PROV, queryEdges, findings })
    const executors: ExecutorRegistry = { ...app, ...ontologyExecutors(port, ctx, PROV), check: checkExecutor(port, ctx, this.rulesByType) }
    let res = start
    for (let i = 0; i < 1000; i++) {
      if (res.status === 'next') {
        const task = res as NextTaskPayload & { status: 'next' }
        if (task.uses) {
          const exec = executors[task.uses]
          if (!exec) throw new Error(`no executor for \`uses: ${task.uses}\` (step "${task.task}") — built-ins: read-sources|ingest|evaluate-rules|report|check; or add app/executors/${task.uses}.js`)
          // ONE STEP FAILING MUST NOT KILL THE RUN.
          //
          // This `await` was previously bare, so an executor that threw propagated out of the drive loop and
          // the whole run died — including steps that declare `depends: []` and share nothing with the
          // failure. Measured cost (a real deployment, 04/08/2026): one unparseable client spreadsheet took down
          // an entire ingest and **22 healthy files were never read**.
          //
          // The failure is still a failure: `orch.fail` records it, it does NOT satisfy a dependency, so the
          // failed step's subtree stays blocked and the run cannot report a clean `complete`. What changes is
          // only the blast radius — from "everything" to "what actually depended on it".
          let r: Awaited<ReturnType<typeof exec.run>>
          try {
            r = await exec.run({ task, input, projectBaseDir: task.project_base_dir, profile: this.decls.manifest.profile })
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e)
            await this.log(ctx.tenantId, 'step-failed', task.task, { uses: task.uses, error: msg })
            res = await orch.fail(task.task, msg)
            continue
          }
          await this.log(ctx.tenantId, 'step', task.task, {
            uses: task.uses,
            ...(r.exports ? { exports: Object.keys(r.exports) } : {}),
          })
          res = await orch.done(task.task, r.exports ? { exports: r.exports } : {})
        } else {
          // an agent step — the session must run its skill (subagent), then call done().
          // `sources` are the step's declared context files (e.g. the
          // `dqa-context.json` a prior `read-sources` step produced) so an
          // extractor skill knows what to read; `output` is where to write.
          // The skill's frontmatter declares the command-set ops it may call;
          // surface body + tools so the agent knows the procedure AND its door.
          const skill = parseSkill(task.instruction)
          // Hand control to the agent under a HARD capability grant: the
          // command-set will refuse any Action not in this step's `tools:`.
          const tenantDir = path.join(this.opts.workspace, '.dqa', 'projects', ctx.tenantId)
          await writeGrant(tenantDir, {
            task: task.task,
            tools: skill.tools ?? [],
            issuedAt: new Date().toISOString(),
          })
          return {
            workflow: workflow.name,
            resumed,
            status: 'agent',
            task: task.task,
            ...(skill.body ? { instruction: skill.body } : {}),
            ...(skill.tools ? { tools: skill.tools } : {}),
            output: task.output,
            ...(task.context?.files?.length ? { sources: task.context.files } : {}),
          }
        }
      } else if (res.status === 'waiting') {
        return { workflow: workflow.name, resumed, status: 'waiting', gate: res.gate, description: res.description }
      } else if (res.status === 'complete') {
        await this.log(ctx.tenantId, 'step', 'complete')
        const failed = (res as { summary?: { tasksFailed?: Array<{ task: string; error: string }> } }).summary?.tasksFailed
        if (failed?.length) await this.log(ctx.tenantId, 'step-failed', '_run-summary', { failed })
        return {
          workflow: workflow.name, resumed, status: 'complete',
          report: await this.readReport(ctx.tenantId, workflow),
          ...(failed?.length ? { failed } : {}),
        }
      } else {
        return { workflow: workflow.name, resumed, status: 'blocked', detail: res }
      }
    }
    return { workflow: workflow.name, resumed, status: 'blocked', detail: 'drive exceeded 1000 steps' }
  }

  private async readReport(tenant: string, workflow: WorkflowV3): Promise<string> {
    const phases = workflow.phases as Record<string, { tasks?: Array<Record<string, unknown>> }>
    const tasks = Object.values(phases).flatMap((p) => p.tasks ?? [])
    const reportStep = tasks.find((t) => t.uses === 'report')
    const out = ((reportStep?.with as Record<string, unknown> | undefined)?.output as string | undefined) ?? 'report.md'
    return fs.readFile(path.join(this.opts.workspace, '.dqa', 'projects', tenant, out), 'utf-8').catch(() => '')
  }
}
