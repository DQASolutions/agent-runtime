// FieldApp — the convention-over-configuration boot for a DQA FieldOS app.
// An app is its declarations (ontology + rules + workflow); this wires the
// kernel (ontology runtime → governance → loaders → ontology executors →
// engine runner) so booting + running a case is two lines:
//
//   const app = await FieldApp.load({ appDir: './app' })
//   const result = await app.run(caseJson, { tenant: 'acme' })
//
// Multi-tenant: the app installs lazily per tenant; cases on different projects
// are isolated. The only thing an app may add is SPI (the `functions` hook).

import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import {
  Orchestrator,
  WorkflowRunner,
  loadState,
  getStateDir,
  type WorkflowV3,
  type NextResult,
} from '@dqa-ai-solutions/agent-orchestrator'
import {
  createOntology,
  InMemoryAdapter,
  type StorageAdapter,
  type Ontology,
  type Ctx,
  type Provenance,
} from '@dqa-ai-solutions/core-runtime'
import { GovernedOntologyPort, rbacInterceptor, auditInterceptor, type AuditRecord } from '@dqa-ai-solutions/core-runtime'
import { loadOntology, loadRules, type OntologyDecl, type RulesDecl } from '@dqa-ai-solutions/core-runtime'
import { loadSkills, ontologyExecutors, checkExecutor } from '@dqa-ai-solutions/agent-steps'
import { loadFunctions, loadRuleStore, paramResolver, mergeRulesByType, type RulesByType } from '@dqa-ai-solutions/core-runtime'
import { readAppDecl } from './load-app.js'
import { buildStorage, type AppManifest } from '@dqa-ai-solutions/core-runtime'
import { appendTrace } from './trace.js'

export interface FieldAppOptions {
  /** Read ontology / workflow (+ optional rules) from this directory.
   *  Each is `<base>.(yaml|yml|json)` — YAML preferred, JSON still works. */
  appDir?: string
  /** …or pass the declarations directly. */
  ontology?: OntologyDecl
  rules?: RulesDecl
  workflow?: WorkflowV3
  /** Storage backend (default: in-memory). */
  adapter?: StorageAdapter
  /** RBAC policy on the write door (default: allow all). */
  rbac?: (action: string, ctx: Ctx) => boolean
  /** Optional SPI hook to bind custom Function/Action bodies. */
  functions?: (ontology: Ontology, ctx: Ctx) => Promise<void> | void
  /** Boilerplate for rules that omit provenance. */
  ruleDefaults?: { source_ref?: string; confirmed_by?: string }
  /** Review/as-of date (YYYY-MM-DD) for resolving effective-dated `param` thresholds
   *  loaded from `<appDir>/law-parameters.json`. Required only by rules that use the
   *  `param` op; all other rules ignore it. */
  asOf?: string
  /** Where run state/outputs live (default: a fresh temp dir per run). */
  workspaceDir?: string
}

export interface FieldAppRunOptions {
  tenant?: string
  actor?: string
  /** Return true to approve a gate and continue; false to stop. Default: approve. */
  onGate?: (gate: string, description: string) => boolean | Promise<boolean>
}

export interface RunResult {
  status: NextResult['status']
  gateApproved: boolean
  /** Number of audit entries written during the run: one per governed action, and one per ingest batch. */
  audited: number
  /** Final run-state exports (declared step outputs — flagged, findings, …). */
  exports: Record<string, unknown>
  /** The report step's output file content, if the workflow writes one. */
  report: string
}

const DEFAULT_PROV: Provenance = { source_ref: 'dqa-fos', confirmed_by: 'system', confirmed_at: '2026-01-01T00:00:00.000Z' }

export class FieldApp {
  private readonly installed = new Set<string>()
  /** Function-rules grouped by type (from the app's functions/), for `check`. */
  private rulesByType: RulesByType = {}

  private constructor(
    private readonly decls: { ontology: OntologyDecl; rules: RulesDecl; workflow: WorkflowV3 },
    private readonly ontology: Ontology,
    private readonly opts: FieldAppOptions,
    /** Backend needs schema provisioning (postgres) before the first write. */
    private readonly provision: boolean,
    /** Industry overlays (manifest.overlays) to layer over base functions/. */
    private readonly overlays: string[],
    /** app default profile/mode (manifest.profile) → every StepContext. */
    private readonly profile: string | undefined,
  ) {}

  /** Boot an app from its declarations (app dir or inline). */
  static async load(opts: FieldAppOptions): Promise<FieldApp> {
    const { manifest, ...decls } = await resolveDecls(opts)
    // Adapter precedence: an explicitly injected adapter wins; otherwise the
    // app's declared backend (app.yaml → storage); otherwise the in-memory
    // default (preserves the convention-over-configuration boot).
    let adapter = opts.adapter
    let provision = false
    if (!adapter && manifest.storage) {
      const built = buildStorage(manifest.storage, {
        workspace: opts.workspaceDir ?? process.cwd(),
        tenant: 'default', // re-scoped per run by ontology.withTenant(ctx.tenant)
      })
      adapter = built.adapter
      provision = built.provision
    }
    const ontology = createOntology({ adapter: adapter ?? new InMemoryAdapter() })
    // Review date for `param` resolution: explicit opts wins, else app.yaml `asOf`.
    const withAsOf = { ...opts, asOf: opts.asOf ?? manifest.asOf }
    return new FieldApp(decls, ontology, withAsOf, provision, manifest.overlays ?? [], manifest.profile)
  }

  /** The underlying ontology — for SPI binding or direct queries. */
  get ontologyRuntime(): Ontology {
    return this.ontology
  }

  /** Run one case (the input is whatever the first step consumes, e.g. JSON). */
  async run(input: string, runOpts: FieldAppRunOptions = {}): Promise<RunResult> {
    const ctx: Ctx = { tenantId: runOpts.tenant ?? 'default', actor: runOpts.actor ?? 'system' }
    await this.ensureInstalled(ctx)

    const ws = this.opts.workspaceDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-fos-')))
    const tenantDir = path.join(ws, '.dqa', 'projects', ctx.tenantId)
    await fs.mkdirp(tenantDir)

    const audit: AuditRecord[] = []
    const port = new GovernedOntologyPort(this.ontology, [
      rbacInterceptor(this.opts.rbac ?? (() => true)),
      auditInterceptor(async (r) => {
        audit.push(r)
        await appendTrace(tenantDir, {
          tenant: ctx.tenantId,
          actor: r.actor,
          kind: 'act',
          name: r.action,
          ...(r.params !== undefined ? { args: r.params } : {}),
          result: { events: r.events },
          ...(r.provenance ? { provenance: r.provenance } : {}),
        })
      }),
    ])

    let gateApproved = false
    const runner = new WorkflowRunner(
      new Orchestrator(ws, ctx.tenantId, this.decls.workflow),
      { ...ontologyExecutors(port, ctx, DEFAULT_PROV), check: checkExecutor(port, ctx, this.rulesByType) },
      { profile: this.profile },
    )
    const res = await runner.run({
      input,
      onGate: async (g, d) => {
        gateApproved = true
        return runOpts.onGate ? await runOpts.onGate(g, d) : true
      },
    })

    const exports = await loadState(getStateDir(ws, ctx.tenantId)).then((s) => s.exports).catch(() => ({}))
    const report = await this.readReport(tenantDir)
    if (!this.opts.workspaceDir) await fs.remove(ws)

    return { status: res.status, gateApproved, audited: audit.length, exports, report }
  }

  private async ensureInstalled(ctx: Ctx): Promise<void> {
    if (this.installed.has(ctx.tenantId)) return
    await loadOntology(this.ontology, this.decls.ontology, ctx)
    // Provision the backend schema before writes (postgres); no-op for the
    // schemaless in-memory default.
    if (this.provision) await this.ontology.migrate(ctx)
    await loadRules(this.ontology, this.decls.rules, ctx, this.opts.ruleDefaults ?? {})
    if (this.opts.appDir) {
      const base = path.join(this.opts.appDir, 'functions')
      const layers = [base, ...this.overlays.map((n) => path.join(this.opts.appDir!, 'overlays', n, 'functions'))]
      const funcRules = await loadFunctions(this.ontology, layers, ctx)
      // Rules-as-DATA store: app/rules/*.json (+ overlay stores) — JSON rules an
      // expert approved, compiled at load via ruleFromIR and swept like code rules.
      const ruleStores = [
        path.join(this.opts.appDir, 'rules'),
        ...this.overlays.map((n) => path.join(this.opts.appDir!, 'overlays', n, 'rules')),
      ]
      // Effective-dated law thresholds for the `param` op: convention file
      // `<appDir>/law-parameters.json` → paramResolver, resolved at `opts.asOf`.
      // Absent file ⇒ rt={} ⇒ identical to before. Only rules using `param` read this.
      const lawParamFile = path.join(this.opts.appDir, 'law-parameters.json')
      const rt = (await fs.pathExists(lawParamFile))
        ? { params: paramResolver(await fs.readJson(lawParamFile)), asOf: this.opts.asOf }
        : {}
      this.rulesByType = mergeRulesByType(funcRules, await loadRuleStore(ruleStores, rt))
    }
    if (this.opts.functions) await this.opts.functions(this.ontology, ctx)
    this.installed.add(ctx.tenantId)
  }

  private async readReport(tenantDir: string): Promise<string> {
    const phases = this.decls.workflow.phases as Record<string, { tasks?: Array<Record<string, unknown>> }>
    const tasks = Object.values(phases).flatMap((p) => p.tasks ?? [])
    const reportStep = tasks.find((t) => t.uses === 'report')
    const out = ((reportStep?.with as Record<string, unknown> | undefined)?.output as string | undefined) ?? 'report.md'
    return fs.readFile(path.join(tenantDir, out), 'utf-8').catch(() => '')
  }
}

async function resolveDecls(
  opts: FieldAppOptions,
): Promise<{ ontology: OntologyDecl; rules: RulesDecl; workflow: WorkflowV3; manifest: AppManifest }> {
  if (opts.appDir) {
    const dir = opts.appDir
    const workflow = await readAppDecl<WorkflowV3>(dir, 'workflow')
    // Per-step skills (app/skills/<task-id>.md) become each task's instruction.
    const skillsDir = path.join(dir, 'skills')
    if (await fs.pathExists(skillsDir)) await loadSkills(workflow, skillsDir)
    // ontology required; rules optional (new apps express checks as functions);
    // manifest optional (absent → in-memory default).
    return {
      ontology: await readAppDecl<OntologyDecl>(dir, 'ontology'),
      rules: await readAppDecl<RulesDecl>(dir, 'rules', {}),
      workflow,
      manifest: await readAppDecl<AppManifest>(dir, 'app', {}),
    }
  }
  if (!opts.workflow) throw new Error('FieldApp.load: provide appDir or { ontology, rules, workflow }')
  return { ontology: opts.ontology ?? {}, rules: opts.rules ?? {}, workflow: opts.workflow, manifest: {} }
}
