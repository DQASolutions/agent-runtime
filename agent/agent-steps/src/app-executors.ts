// App-provided workflow executors. The kernel ships a few mandatory built-ins
// (read-sources · ingest · evaluate-rules · report · check); an app may add its
// OWN deterministic steps by dropping compiled `.js` files in `app/executors/`.
// Each becomes a `uses: <filename>` step the orchestrator runs automatically —
// a first-class part of the workflow, NOT a script someone runs on the side.
//
// This is the home for deterministic bulk work an LLM skill cannot do (parse a
// 12k-row journal, derive 30k edges, compute a balance sheet): the executor
// EXTRACTS to an IngestPayload file, then a downstream `ingest` step materialises
// it through the one governed write door (which also validates it atomically).
// An executor that needs to read/write the graph directly may take the governed
// `port`; a pure extractor ignores it.
//
// Contract — a `app/executors/<name>.js` default-exports EITHER:
//   • a StepExecutor object `{ run(ctx) }`, or
//   • a factory `(io: AppExecutorIO) => StepExecutor`  (io carries the governed port).
// The `uses:` key is the filename without `.js`. Built-ins always win on a name
// clash (an app cannot shadow `ingest`).

import fs from 'fs-extra'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { StepExecutor, ExecutorRegistry } from '@dqa-ai-solutions/agent-orchestrator'
import type { OntologyPort, Ctx, Provenance } from '@dqa-ai-solutions/ontology-runtime'
import type { RuleFinding } from './executors.js'

/** What an app executor factory receives — the governed port + context, for
 *  executors that read/write the ontology directly. Pure extractors ignore it. */
export interface AppExecutorIO {
  port: OntologyPort
  ctx: Ctx
  prov: Provenance
  /** Read-only BULK edge read (one call) for a relationship — for perf-sensitive
   *  executors that would otherwise do N per-node `neighbors()` round-trips
   *  (vd duyệt 12k bút toán). Trả mọi cạnh của quan hệ đó trong tenant hiện tại. */
  queryEdges: (relationship: string) => Promise<Array<{ fromId: string; toId: string }>>
  /** Evaluate the app's OWN function-rules → enriched findings (message, delta,
   *  category). Lets an app report executor render rule findings instead of
   *  re-deriving the same checks inline — ONE source of truth. `types` defaults
   *  to every type that has rules. */
  findings: (types?: string[]) => Promise<RuleFinding[]>
}

type AppExecutorModule = StepExecutor | ((io: AppExecutorIO) => StepExecutor)

/** Load every `app/executors/*.js` into a registry keyed by filename. Missing
 *  dir → empty registry (an app need not ship any). */
export async function loadAppExecutors(appDir: string, io: AppExecutorIO): Promise<ExecutorRegistry> {
  const dir = path.join(appDir, 'executors')
  if (!(await fs.pathExists(dir))) return {}
  const registry: ExecutorRegistry = {}
  for (const f of (await fs.readdir(dir)).filter((f) => f.endsWith('.js')).sort()) {
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as { default?: AppExecutorModule }
    const exp = mod.default
    if (!exp) continue
    registry[f.replace(/\.js$/, '')] = typeof exp === 'function' ? exp(io) : exp
  }
  return registry
}
