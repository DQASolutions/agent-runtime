// Transport — how a request enters the kernel. The KEY contract for the
// "ok for both horizons" bet (os-runtime-design.md §2, DoD E): both the CLI
// (`dqa emit-event`) and the HTTP service (`POST /events`) are thin adapters
// that call the SAME core `Kernel.emitEvent` handler. The core is
// transport-agnostic; adding the service later is a second adapter, not a
// rewrite. (Increment 2 implements `Kernel`; this file fixes the seam.)

import type { Args } from '@dqa-ai-solutions/core-runtime'

/** External data arriving at the async front door (drained → an ingest-intent). */
export interface IngressInput {
  tenant: string
  /** App namespace the data belongs to, e.g. `demo`. */
  app: string
  /** Namespaced action the data proposes, e.g. `demo:ingestDoc`. */
  action: string
  /** Ontology Values (JSON-shaped) — flow straight to applyAction. */
  params: Args
}

/**
 * The single core surface every transport calls. An adapter (CLI / HTTP) only
 * translates its wire format into these calls — nothing kernel-specific lives
 * in the adapter.
 */
export interface Kernel {
  /** Outside world proposes a write — enqueues an ingest-intent. Returns the
   *  intent id so a caller can correlate. Does NOT apply the write inline; the
   *  scheduler drains it through the Action door. */
  emitEvent(input: IngressInput): Promise<{ intentId: string }>
}
