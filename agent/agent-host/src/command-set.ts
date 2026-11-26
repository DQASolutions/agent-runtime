// The governed command-set over an app's ontology — the ONLY door a skill
// (Claude Code) uses during an investigation step. Reads are ground truth from
// the graph; writes go through Actions (RBAC + audit + provenance). It opens the
// SAME filesystem store a FieldSession run uses (same workspace + tenant), and
// — because each CLI invocation is a fresh process — reloads the app's ontology
// types and rebinds its functions before running one operation.
//
// query / get / call → read·compute (no mutation). act → governed write.
// note → append a human review note (audit trail of dismissed flags).

import fs from 'fs-extra'
import path from 'node:path'
import {
  createOntology,
  type Ctx,
  type Provenance,
  type Instance,
  type Value,
  type OntologyEvent,
  type ConditionExpr,
  type Args,
  type StorageAdapter,
} from '@dqa-ai-solutions/ontology-runtime'
import {
  GovernedOntologyPort,
  GovernanceError,
  rbacInterceptor,
  auditInterceptor,
  capabilityInterceptor,
  type ActionInterceptor,
  type AuditRecord,
} from '@dqa-ai-solutions/ontology-runtime'
import { loadOntology, type OntologyDecl } from '@dqa-ai-solutions/ontology-runtime'
import { loadFunctions } from '@dqa-ai-solutions/ontology-runtime'
import { readAppDecl } from './load-app.js'
import { buildStorage, type AppManifest } from '@dqa-ai-solutions/ontology-runtime'
import { appendTrace, type TraceKind } from './trace.js'
import { readGrant } from './grant.js'

export interface CommandSetOptions {
  /** app dir (ontology types + functions). */
  appDir: string
  /** Working dir holding .dqa/ (the same store a FieldSession run uses). */
  workspace: string
  /** Tenant whose case the skill is investigating (default: 'default'). */
  tenant: string
  /** Who is acting (drives RBAC + provenance). */
  actor?: string
  /** RBAC policy on the write door (default: allow all). */
  rbac?: (action: string, ctx: Ctx) => boolean
}

export class CommandSet {
  private constructor(
    private readonly port: GovernedOntologyPort,
    private readonly ctx: Ctx,
    private readonly opts: CommandSetOptions,
    private readonly tenantDir: string,
    /** The storage backend — held so `close()` can dispose its connection pool. */
    private readonly adapter: StorageAdapter,
    /** Workflow task the active grant is for (for ledger attribution). */
    private readonly grantTask?: string,
  ) {}

  /** Open the command-set against a tenant's store, with the app's functions bound. */
  static async open(opts: CommandSetOptions): Promise<CommandSet> {
    const ctx: Ctx = { tenantId: opts.tenant, actor: opts.actor ?? 'session' }
    // Open the SAME backend the session run uses — read it from the app manifest
    // (filesystem default). The schema was already provisioned by the session run
    // that owns this case, so the command-set only connects + reads/acts.
    const manifest = await readAppDecl<AppManifest>(opts.appDir, 'app', {})
    const { adapter } = buildStorage(manifest.storage, { workspace: opts.workspace, tenant: opts.tenant })
    const ontology = createOntology({ adapter })
    await loadOntology(ontology, await readAppDecl<OntologyDecl>(opts.appDir, 'ontology'), ctx)
    await loadFunctions(ontology, path.join(opts.appDir, 'functions'), ctx)
    const tenantDir = path.join(opts.workspace, '.dqa', 'projects', opts.tenant)
    // A present grant makes the write door HARD: only its `tools` may be applied.
    // No grant (standalone use, no governed step in flight) → unconstrained.
    const grant = await readGrant(tenantDir)
    const chain: ActionInterceptor[] = [
      ...(grant ? [capabilityInterceptor(grant.tools)] : []),
      rbacInterceptor(opts.rbac ?? (() => true)),
      auditInterceptor((rec: AuditRecord) =>
        appendTrace(tenantDir, {
          tenant: opts.tenant,
          ...(grant?.task ? { task: grant.task } : {}),
          actor: rec.actor,
          kind: 'act',
          name: rec.action,
          ...(rec.params !== undefined ? { args: rec.params } : {}),
          result: { events: rec.events },
          ...(rec.provenance ? { provenance: rec.provenance } : {}),
        }).then(() => undefined),
      ),
    ]
    const port = new GovernedOntologyPort(ontology, chain)
    return new CommandSet(port, ctx, opts, tenantDir, adapter, grant?.task)
  }

  /** Dispose the storage backend's connection pool (Neo4j Bolt driver, pg Pool) so
   *  the process can exit. No-op for the pool-less filesystem / in-memory backends.
   *  Call once when done with this command-set (CLI op end, dogfood teardown). */
  async close(): Promise<void> {
    await this.adapter.close?.()
  }

  /** Read instances of a type (optionally filtered) — ground truth. */
  async query(type: string, where?: ConditionExpr): Promise<Instance[]> {
    const rows = await this.port.find(type, where, this.ctx)
    await this.trace('read', type, where ? { where } : undefined, { count: rows.length })
    return rows
  }

  /** Read one instance by id. */
  async get(id: string): Promise<Instance | null> {
    const inst = await this.port.get(id, this.ctx)
    await this.trace('read', 'get', { id }, { found: Boolean(inst) })
    return inst
  }

  /** Run a named pure Function — deterministic compute, no mutation. */
  async call(fn: string, args: Args = {}): Promise<Value> {
    const value = await this.port.callFunction(fn, args, this.ctx)
    await this.trace('call', fn, args, { value: summarizeValue(value) })
    return value
  }

  /** Apply a governed Action — the sole write door (capability + rbac + audit +
   *  provenance). A capability/RBAC denial is recorded to the ledger, then rethrown. */
  async act(action: string, params: Args = {}): Promise<OntologyEvent[]> {
    const prov: Provenance = {
      source_ref: 'command-set',
      confirmed_by: this.ctx.actor ?? 'session',
      confirmed_at: new Date().toISOString(),
    }
    try {
      return await this.port.applyAction(action, params, prov, this.ctx)
    } catch (err) {
      if (err instanceof GovernanceError) {
        await appendTrace(this.tenantDir, {
          tenant: this.opts.tenant,
          ...(this.grantTask ? { task: this.grantTask } : {}),
          actor: this.ctx.actor ?? 'session',
          kind: 'denied',
          name: action,
          args: params,
          result: { code: err.code, message: err.message },
        })
      }
      throw err
    }
  }

  /** Record a human review note (e.g. "reviewed, dismissed") — audit trail. */
  async note(id: string, text: string): Promise<void> {
    await fs.ensureDir(this.tenantDir)
    const entry = { id, text, by: this.ctx.actor ?? 'session', at: new Date().toISOString() }
    await fs.appendFile(path.join(this.tenantDir, 'review-notes.jsonl'), JSON.stringify(entry) + '\n')
    await this.trace('note', 'note', { id }, { text })
  }

  /** Append a command-set operation to the case ledger (full audit trail). */
  private async trace(kind: TraceKind, name: string, args?: unknown, result?: unknown): Promise<void> {
    await appendTrace(this.tenantDir, {
      tenant: this.opts.tenant,
      ...(this.grantTask ? { task: this.grantTask } : {}),
      actor: this.ctx.actor ?? 'session',
      kind,
      name,
      ...(args !== undefined ? { args } : {}),
      ...(result !== undefined ? { result } : {}),
    })
  }
}

/** Keep the ledger small: log primitives verbatim, larger values by shape only. */
function summarizeValue(v: unknown): unknown {
  if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) return v
  return { type: Array.isArray(v) ? 'array' : typeof v }
}
