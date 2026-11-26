// Ontology StepExecutors — the kernel-side handlers the WorkflowRunner invokes
// for ontology-backed workflow steps. The app's workflow just says
// `uses: ingest | evaluate-rules | report`; these executors do the work through
// the (governed) Ontology Port. No app code drives the steps.

import fs from 'fs-extra'
import path from 'node:path'
import { ingestFolder } from '@dqa-ai-solutions/ingest-documents'
import type { StepExecutor, ExecutorRegistry, StepContext } from '@dqa-ai-solutions/agent-orchestrator'
import type { OntologyPort, Ctx, Provenance, RuleResult, Instance, FunctionIO } from '@dqa-ai-solutions/ontology-runtime'
import { validateIngestPayload, IngestValidationError } from './ingest-payload-validator.js'
import type { RuleSpec, Finding, RulesByType } from '@dqa-ai-solutions/ontology-runtime'

/** A case payload for the `ingest` step. Arrives either as the run input (JSON)
 *  or — for real sources — as a file an upstream extractor skill wrote, named
 *  by `with.from`. */
export interface IngestPayload {
  /** `sourceRef` — xuất xứ RIÊNG của bản ghi (tệp + băm nội dung). Xem BulkInstanceRow. */
  instances?: Array<{ type: string; props?: Record<string, unknown>; ref?: string; sourceRef?: string }>
  links?: Array<{ relationship: string; from: string; to: string }>
}

/**
 * Resolve the ingest payload for a step. When `with.from` names a file (relative
 * to the project base dir), read the structured payload an upstream EXTRACTOR
 * step produced from real documents — this is the handoff seam that lets an app
 * decide *what* to extract in a skill, then materialise it here. Otherwise fall
 * back to the run input (the pre-structured case, as the dogfood passes).
 */
async function resolveIngestPayload(sc: StepContext): Promise<IngestPayload> {
  const from = sc.task.with?.from as string | undefined
  if (from) {
    const fromPath = path.resolve(sc.projectBaseDir, from)
    return (await fs.readJson(fromPath)) as IngestPayload
  }
  return sc.input ? (JSON.parse(sc.input) as IngestPayload) : {}
}

/**
 * `ingest` — materialise a case into the ontology via the governed write door.
 * The case is either pre-structured (run input) or read from the file an
 * upstream extractor skill wrote (`with.from`); see {@link resolveIngestPayload}.
 * Local `ref` aliases on instances are resolved to created ids for the links.
 *
 * IDEMPOTENT: an instance carrying a `ref` is materialised via `upsertInstance`,
 * whose id is derived deterministically from (tenant, type, ref). So re-running
 * the same payload — an interrupted run that retries, or a customer re-loading
 * after adding more data — overwrites the same nodes instead of duplicating the
 * graph; `link()` is already edge-idempotent, so edges converge too. An instance
 * WITHOUT a ref has no stable key, so it falls back to `createInstance` (a fresh
 * node each run, as before).
 */
export function ingestExecutor(port: OntologyPort, ctx: Ctx, prov: Provenance): StepExecutor {
  return {
    async run(sc) {
      const payload = await resolveIngestPayload(sc)
      // Pre-flight: validate the WHOLE payload against the installed schema
      // before writing anything, so a malformed (often LLM-extracted) payload
      // fails atomically with one clear report instead of half-writing the graph.
      const check = validateIngestPayload(payload, await port.getSchema(ctx))
      if (!check.ok) throw new IngestValidationError(check.errors)
      // Bulk write door: one UNWIND batch per ~1000 rows + ONE coarse audit
      // entry, instead of N governed applyAction calls (each a round-trip +
      // per-item ledger append). The payload is already validated atomically
      // above, so the per-item guard applyAction would re-run is redundant here.
      const { instances, links, linked } = await port.ingestBulk(payload, prov, ctx)
      // `links` = ĐÃ XIN, `linked` = ĐÃ CÓ trên graph. Bản cũ đặt tên số đã xin là `linked` — chính cái tên
      // ấy khiến mọi người (kể cả bộ đọc mẫu số) hiểu là "đã nối xong", trong khi cạnh có thể rơi hết vào
      // khoảng không: adapter dựng cạnh bằng `MATCH (a),(b) MERGE …`, thiếu một đầu thì khớp rỗng, KHÔNG
      // cạnh, KHÔNG lỗi. Đo trên khách thật: một payload khai 1.436 cạnh mà graph có 0, vẫn báo "thành công".
      //
      // Nay báo cả hai, và chênh lệch được NÊU RA thay vì phải đi đo lại graph ở một bước khác.
      return {
        exports: {
          ingested: instances,
          linkRequested: links,
          linked,
          ...(links > linked ? { linkMissing: links - linked } : {}),
        },
      }
    },
  }
}

async function evaluateScopes(port: OntologyPort, tenantId: string, entityTypes: string[]): Promise<RuleResult[]> {
  let results: RuleResult[] = []
  for (const et of entityTypes) results = results.concat(await port.evaluateRules({ tenantId, entityType: et }))
  return results
}

/**
 * `evaluate-rules` — neutral rule evaluation over the entity types named in
 * `with.entityTypes`. Returns a COMPACT structured output the engine branches
 * on: `{ flagged, findings, byRule }`. (Trace-heavy detail stays in the graph.)
 */
export function evaluateRulesExecutor(port: OntologyPort, ctx: Ctx): StepExecutor {
  return {
    async run(sc) {
      const entityTypes = (sc.task.with?.entityTypes as string[] | undefined) ?? []
      const results = await evaluateScopes(port, ctx.tenantId, entityTypes)
      const byRule: Record<string, number> = {}
      for (const r of results) byRule[r.ruleId] = (byRule[r.ruleId] ?? 0) + 1
      return { exports: { flagged: results.length > 0, findings: results.length, byRule } }
    },
  }
}

/**
 * `report` — render a findings summary (re-evaluating the scopes) and write it
 * to `with.output` (default report.md). A rich template is an app skill (M5);
 * this is the kernel-generic summary.
 */
export function reportExecutor(port: OntologyPort, ctx: Ctx): StepExecutor {
  return {
    async run(sc) {
      const entityTypes = (sc.task.with?.entityTypes as string[] | undefined) ?? []
      const out = (sc.task.with?.output as string | undefined) ?? 'report.md'
      const results = await evaluateScopes(port, ctx.tenantId, entityTypes)

      const byRule = new Map<string, RuleResult[]>()
      for (const r of results) {
        const arr = byRule.get(r.ruleId)
        if (arr) arr.push(r)
        else byRule.set(r.ruleId, [r])
      }
      const lines = [`# Findings report`, '', `Total findings: ${results.length}`, '']
      for (const [ruleId, rs] of byRule) {
        lines.push(`- **${ruleId}** (${rs[0].severityLabel ?? '—'}) × ${rs.length} → \`${rs[0].onFail?.action ?? 'review'}\``)
      }
      if (results.length === 0) lines.push('No rules fired — clean.')
      const outPath = path.join(sc.projectBaseDir, out)
      await fs.ensureDir(path.dirname(outPath))
      await fs.writeFile(outPath, lines.join('\n') + '\n')
      return { exports: { findings: results.length, reportPath: out } }
    },
  }
}

/**
 * `read-sources` — turn a folder of mixed-format source files (PDF / DOCX /
 * PPTX / XLSX / images) into the consolidated, domain-neutral `dqa-context.json`
 * inside the project base dir. This is the connect-point for document-ingestion:
 * it deposits the raw extracted content where the next (agent) step's extractor
 * skill can read it, and exports the artifact path so the workflow can wire it
 * forward. Domain-agnostic — it decides nothing about *what* to extract.
 *
 * Params (`with`):
 *   - `folder`  source files, relative to the project base dir (default `sources`)
 *   - `out`     output dir for the ingest artifacts, relative (default `_ingest`)
 *   - `maxTokens` / `maxImages`  optional budget thresholds (warnings only)
 */
export function readSourcesExecutor(): StepExecutor {
  return {
    async run(sc) {
      const folder = path.resolve(sc.projectBaseDir, (sc.task.with?.folder as string | undefined) ?? 'sources')
      const outRel = (sc.task.with?.out as string | undefined) ?? '_ingest'
      const outDir = path.resolve(sc.projectBaseDir, outRel)
      const budget = {
        ...(typeof sc.task.with?.maxTokens === 'number' ? { maxTokens: sc.task.with.maxTokens as number } : {}),
        ...(typeof sc.task.with?.maxImages === 'number' ? { maxImages: sc.task.with.maxImages as number } : {}),
      }
      const { manifest, contextPath, skipped } = await ingestFolder({
        folder,
        outDir,
        ...(Object.keys(budget).length ? { budget } : {}),
      })
      return {
        exports: {
          // Path is project-relative so a downstream skill/`with.from` can use it
          // regardless of where the project base dir lives.
          context: path.relative(sc.projectBaseDir, contextPath),
          files: manifest.files.length,
          skipped,
          tokens: manifest.totals.total_tokens,
          images: manifest.totals.total_images,
        },
      }
    },
  }
}

/** Read-only IO surface (bound to a ctx) that function-rules run against. */
export function functionIO(port: OntologyPort, ctx: Ctx, opts?: { cache?: boolean }): FunctionIO {
  // CACHE: chỉ bật cho pha CHỈ-ĐỌC (findings). Một luật khai báo dùng `find` bên trong `any`/`count`
  // sẽ gọi lại kho MỘT LẦN MỖI BẢN GHI — trên vài trăm tài khoản × vài nghìn bút toán, đó là khác biệt
  // giữa "luật này khai được" và "luật này buộc phải viết tay". KHÔNG bật cho pha có ghi (ingest):
  // ở đó đọc lại phải thấy dữ liệu vừa ghi.
  const src = port as unknown as { incoming?: (id: string, rel: string) => Promise<Instance[]> }
  const hasIncoming = typeof src.incoming === 'function'
  const fwdIncoming = (id: string, rel: string): Promise<Instance[]> => src.incoming!(id, rel)

  if (!opts?.cache) {
    return {
      get: (id) => port.get(id, ctx),
      find: (type, where) => port.find(type, where, ctx),
      neighbors: (id, relationship) => port.neighbors(id, relationship, ctx),
      traverse: (spec) => port.traverse(spec, ctx),
      // Chuyển tiếp phép đi cạnh NGƯỢC nếu host có cấp — CẢ HAI nhánh, vì `checkExecutor` đi nhánh
      // không-cache. Thiếu ở một nhánh là luật chạy được ở đường này, chết ở đường kia.
      ...(hasIncoming ? { incoming: fwdIncoming } : {}),
    }
  }
  const finds = new Map<string, Promise<Instance[]>>()
  const nbrs = new Map<string, Promise<Instance[]>>()
  return {
    get: (id) => port.get(id, ctx),
    find: (type, where) => {
      const k = `${type}|${where === undefined ? '' : JSON.stringify(where)}`
      let p = finds.get(k)
      if (!p) { p = port.find(type, where, ctx) as Promise<Instance[]>; finds.set(k, p) }
      return p
    },
    neighbors: (id, relationship) => {
      const k = `${id}|${relationship}`
      let p = nbrs.get(k)
      if (!p) { p = port.neighbors(id, relationship, ctx) as Promise<Instance[]>; nbrs.set(k, p) }
      return p
    },
    traverse: (spec) => port.traverse(spec, ctx),
    ...(hasIncoming ? { incoming: fwdIncoming } : {}),
  }
}

/**
 * One enriched finding: which rule fired, on which instance, plus the rule's
 * own human/numeric detail ({@link Finding}). This is the shape a report (the
 * kernel `report` OR an app report executor) renders — so the RULE, not a
 * separate engine, owns "what's wrong, by how much, in which bucket".
 */
export interface RuleFinding {
  ruleId: string
  instance: string
  severity?: string
  category?: string
  label?: string
  message?: string
  delta?: number
}

/** Fold a rule + its violating instance (and any inline {@link Finding}) into a
 *  flat {@link RuleFinding}. Detail precedence: inline verdict → `moTa` → bare. */
async function toRuleFinding(r: RuleSpec, g: Instance, io: FunctionIO, inline?: Finding): Promise<RuleFinding> {
  const f = inline ?? (r.moTa ? await r.moTa(g, io) : undefined)
  const category = f?.category ?? r.category
  return {
    ruleId: r.id,
    instance: g.id,
    // mức của CA cụ thể thắng mức tĩnh của luật
    ...(f?.severity ?? r.severity ? { severity: f?.severity ?? r.severity } : {}),
    ...(category ? { category } : {}),
    ...(f?.label ? { label: f.label } : {}),
    ...(f?.message ? { message: f.message } : {}),
    ...(f?.delta !== undefined ? { delta: f.delta } : {}),
  }
}

/** Run one rule against its type → the enriched findings (one per violator). */
async function evalRule(r: RuleSpec, type: string, io: FunctionIO): Promise<RuleFinding[]> {
  const out: RuleFinding[] = []
  if (r.timViPham) {
    for (const g of await r.timViPham(io)) out.push(await toRuleFinding(r, g, io))
    return out
  }
  for (const g of await io.find(type, undefined)) {
    const v = await r.khi!(g, io)
    if (!v) continue
    out.push(await toRuleFinding(r, g, io, typeof v === 'object' ? v : undefined))
  }
  return out
}

/**
 * Sweep the app's function-rules over `types` → enriched findings. The reusable
 * core behind both the `check` step AND an app report executor (via
 * `AppExecutorIO.findings`) — so both read findings from ONE evaluation path.
 */
/** A rule that threw. Reported as a finding so the failure is VISIBLE, never swallowed. */
export const RULE_ERROR_ID = 'R-RULE-ERROR'

/**
 * Sweep every rule over every type.
 *
 * ⚠️ MỘT LUẬT NỔ KHÔNG ĐƯỢC GIẾT CẢ LƯỢT SOÁT. Trước bản vá này, một lỗi như `order comparison ">" on
 * non-numeric values` — sinh ra khi hồ sơ khách thiếu đúng một trường số — ném thẳng ra ngoài và làm rớt
 * TOÀN BỘ đầu ra: khách mất cả trăm phát hiện đúng vì một luật gặp một ô trống.
 *
 * Nhưng cũng KHÔNG được nuốt: luật nổ là luật KHÔNG CHẠY, và "không chạy" đọc y hệt "chạy sạch" nếu im lặng.
 * Nên lỗi được biến thành PHÁT HIỆN mang chính mã luật và câu lỗi — các luật còn lại chạy tiếp, còn cái hỏng
 * thì kêu lên bằng tên nó.
 */
export async function evalFindings(rulesByType: RulesByType, types: string[], io: FunctionIO): Promise<RuleFinding[]> {
  const all: RuleFinding[] = []
  for (const type of types) {
    for (const r of rulesByType[type] ?? []) {
      try {
        all.push(...(await evalRule(r, type, io)))
      } catch (e) {
        const id = (r as { id?: string })?.id ?? '(luật không có mã)'
        all.push({
          ruleId: RULE_ERROR_ID, severity: 'critical', category: 'system',
          entityType: type, instance: `rule-error-${id}`,
          message: `Luật ${id} KHÔNG chạy được trên ${type}: ${(e as Error)?.message ?? String(e)}. `
            + `Phần soát xét thuộc luật này CHƯA được thực hiện — không phải "đạt".`,
        } as RuleFinding)
      }
    }
  }
  return all
}

/**
 * `check` — the function-rule counterpart of `evaluate-rules`. Sweeps the app's
 * function-rules (bound by `loadFunctions`) over the entity types in
 * `with.types` (default: every type that has rules). Each rule is a pure
 * predicate (`khi`, per-instance — the kernel sweeps `find(type)`) or a
 * collection finder (`timViPham`); a fired rule may carry a {@link Finding}.
 * Returns the compact output the workflow branches on:
 * `{ flagged, count, findings, flaggedIds, byRule, byCategory }`.
 */
export function checkExecutor(port: OntologyPort, ctx: Ctx, rulesByType: RulesByType): StepExecutor {
  const io = functionIO(port, ctx)
  return {
    async run(sc) {
      const types = (sc.task.with?.types as string[] | undefined) ?? Object.keys(rulesByType)
      const findings = await evalFindings(rulesByType, types, io)
      const byRule: Record<string, number> = {}
      const byCategory: Record<string, number> = {}
      for (const f of findings) {
        byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
        if (f.category) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
      }
      const flaggedIds = [...new Set(findings.map((f) => f.instance))]
      return { exports: { flagged: findings.length > 0, count: findings.length, findings, flaggedIds, byRule, byCategory } }
    },
  }
}

/** The standard ontology executor set, wired to a (governed) port + context. */
export function ontologyExecutors(port: OntologyPort, ctx: Ctx, prov: Provenance): ExecutorRegistry {
  return {
    'read-sources': readSourcesExecutor(),
    ingest: ingestExecutor(port, ctx, prov),
    'evaluate-rules': evaluateRulesExecutor(port, ctx),
    report: reportExecutor(port, ctx),
  }
}
