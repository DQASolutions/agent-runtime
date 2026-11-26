// Scheduler — drains the WorkQueue (the always-on, non-LLM tier). For each
// intent: ingest → apply through the Action door; spawn-run → Spawner + Driver.
// slice A drains synchronously, one at a time (bounded K = 1 implicitly); the
// bounded-K async worker is a P3 refinement behind the same shape.
//
// A failing intent is ISOLATED (recorded, not fatal) so one bad item never
// kills the drain loop — the defer-not-drop spirit. DoD D relies on this: an
// action rejected at the door surfaces as a failure with NO downstream effect.

import type { OntologyPort, Ctx, Provenance } from '@dqa-ai-solutions/core-runtime'
import type { Intent, IngestIntent, SpawnRunIntent } from '../ports/intent.js'
import type { WorkQueue } from '../ports/work-queue.js'
import type { Spawner } from '../ports/spawner.js'
import type { Driver } from '../ports/driver.js'

export interface SchedulerDeps {
  queue: WorkQueue
  /** The governed write door (e.g. a GovernedOntologyPort). */
  port: OntologyPort
  spawner: Spawner
  driver: Driver
  /** Injectable clock for provenance timestamps (deterministic tests). */
  now?: () => string
}

export interface DrainResult {
  processed: number
  failures: Array<{ intent: Intent; error: unknown }>
}

export class Scheduler {
  private readonly now: () => string

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** Drain until the queue is empty. Returns counts + isolated failures. */
  async drain(): Promise<DrainResult> {
    let processed = 0
    const failures: DrainResult['failures'] = []
    for (;;) {
      const intent = await this.deps.queue.popHighest()
      if (!intent) break
      try {
        if (intent.kind === 'ingest') await this.applyIngest(intent)
        else await this.spawnRun(intent)
        processed++
      } catch (error) {
        failures.push({ intent, error })
      }
      await this.deps.queue.markDone(intent.id)
    }
    return { processed, failures }
  }

  // ingest-intent → governed write. Outside only proposed; the Action door
  // validates/guards/audits. Its emitted events flow to reactionInterceptor
  // (an `after` hook on the port), which enqueues any spawn-run reactions.
  private async applyIngest(intent: IngestIntent): Promise<void> {
    const ctx: Ctx = { tenantId: intent.tenant, actor: 'system' }
    const prov: Provenance = {
      source_ref: `emit-event:${intent.app}`,
      confirmed_by: 'system',
      confirmed_at: this.now(),
    }
    await this.deps.port.applyAction(intent.action, intent.params, prov, ctx)
  }

  // spawn-run-intent → a NEW run (Spawner), then hand to the Driver. slice A's
  // InteractiveDriver is a no-op; the run waits in the ready-set for a session.
  private async spawnRun(intent: SpawnRunIntent): Promise<void> {
    const runRef = await this.deps.spawner.spawn(intent)
    await this.deps.driver.drive(runRef)
  }
}
