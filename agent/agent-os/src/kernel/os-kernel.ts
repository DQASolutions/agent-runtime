// OsKernel — the core `Kernel` handler every transport calls (CLI `dqa
// emit-event` and HTTP `POST /events` are thin adapters over THIS). Per DoD E,
// keeping the kernel transport-agnostic is the proof the design serves both
// horizons.
//
// `emitEvent` does NOT apply the write inline — it enqueues an ingest-intent
// onto the single async front door (①). The scheduler drains it through the
// Action door (②). Outside proposes; Action disposes.

import type { Kernel, IngressInput } from '../ports/transport.js'
import type { IngestIntent } from '../ports/intent.js'
import type { WorkQueue } from '../ports/work-queue.js'

export interface OsKernelOpts {
  /** Default priority for ingest-intents. Default 5. */
  ingestPriority?: number
}

export class OsKernel implements Kernel {
  private seq = 0
  private readonly ingestPriority: number

  constructor(
    private readonly queue: WorkQueue,
    opts: OsKernelOpts = {},
  ) {
    this.ingestPriority = opts.ingestPriority ?? 5
  }

  async emitEvent(input: IngressInput): Promise<{ intentId: string }> {
    const id = `ingest-${++this.seq}`
    const intent: IngestIntent = {
      id,
      kind: 'ingest',
      tenant: input.tenant,
      app: input.app,
      depth: 0, // arrived from outside
      action: input.action,
      params: input.params,
    }
    // Coalesce per business target so a burst of identical inputs (same app +
    // action + ref) collapses to one unit of work.
    const ref = typeof input.params.ref === 'string' ? input.params.ref : JSON.stringify(input.params)
    await this.queue.enqueue(intent, { priority: this.ingestPriority, key: `${input.app}:${input.action}:${ref}` })
    return { intentId: id }
  }
}
