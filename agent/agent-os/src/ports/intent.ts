// Intent — the unit of work submitted to the kernel's SINGLE async front door
// (the WorkQueue). Everything the outside world or an internal reaction wants
// the kernel to *do on its own time* enters as an Intent. (Reads do NOT — they
// go straight to the ontology Query path. Writes go through the Action door.)
//
// Two seams baked in from day one so multi-app / cycle-protection cost nothing
// later (os-runtime-design.md §6): every Intent carries its `app` namespace and
// a causation chain (`causationId` + `depth`).

import type { Args } from '@dqa-ai-solutions/ontology-runtime'

export type IntentKind = 'ingest' | 'spawn-run'

interface IntentBase {
  /** Stable id of this intent (assigned by the producer at enqueue time). */
  id: string
  kind: IntentKind
  /** Tenant the work belongs to — cross-tenant isolation boundary. */
  tenant: string
  /** App namespace that owns / initiated this work (e.g. `demo`). */
  app: string
  /** Event/intent id that caused this one — cascade/cycle guard.
   *  Undefined at an external origin. */
  causationId?: string
  /** Distance from the external origin: 0 = arrived from outside, +1 each hop. */
  depth: number
}

/**
 * External data PROPOSING a governed write. Drained → `applyAction` (the Action
 * door validates/guards/audits; the outside only proposes). The prime-mover
 * ingress (ingestion / webhook / sync) produces these.
 */
export interface IngestIntent extends IntentBase {
  kind: 'ingest'
  /** Namespaced action to apply, e.g. `demo:ingestDoc`. */
  action: string
  /** Action params — ontology Values (JSON-shaped), flow straight to applyAction. */
  params: Args
}

/**
 * A reaction: spawn a NEW workflow run. Per the locked invariant it NEVER barges
 * into a running run — it only starts a fresh one (os-runtime-design.md §6).
 */
export interface SpawnRunIntent extends IntentBase {
  kind: 'spawn-run'
  /** Namespaced workflow to start, e.g. `demo:review`. */
  workflow: string
  seed: Record<string, unknown>
}

export type Intent = IngestIntent | SpawnRunIntent
