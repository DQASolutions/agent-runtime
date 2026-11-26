// reactionInterceptor — the seam that turns ontology writes into reactions.
// It is an `ActionInterceptor.after`, so it fires after EVERY applyAction
// uniformly (human · workflow · trigger · agent) — the design's reason for
// hooking the single write door (os-runtime-design.md §3 ②, §4).
//
// What it does: for each emitted event, find matching triggers and ENQUEUE a
// spawn-run intent. It never writes and never spawns inline — it only proposes
// work onto the queue (the single async front door ①). The scheduler drains it.

import type { ActionInterceptor } from '@dqa-ai-solutions/ontology-runtime'
import type { SpawnRunIntent } from '../ports/intent.js'
import type { WorkQueue } from '../ports/work-queue.js'
import type { TriggerRegistry } from './trigger-def.js'

/**
 * @param registry triggers to match emitted events against
 * @param queue    where matched reactions are enqueued (as spawn-run intents)
 */
export function reactionInterceptor(registry: TriggerRegistry, queue: WorkQueue): ActionInterceptor {
  return {
    async after(_name, events, ctx) {
      for (const ev of events) {
        for (const t of registry.match(ev)) {
          const seed = t.emit.seed ? t.emit.seed(ev) : {}
          const intent: SpawnRunIntent = {
            // Deterministic id (no Math.random) — same event+trigger → same id.
            id: `reaction:${ev.id}:${t.id}`,
            kind: 'spawn-run',
            tenant: ctx.tenantId,
            app: t.app,
            // Causation chain: this reaction was caused by event `ev`. depth=1 is
            // correct for slice A's single hop (external → action → reaction);
            // precise multi-hop depth threading is a P3 item (cross-app cycles).
            causationId: ev.id,
            depth: 1,
            workflow: t.emit.workflow,
            seed,
          }
          // Coalesce per (trigger, target instance): a burst of writes on the
          // same aggregate collapses to ONE run.
          await queue.enqueue(intent, { priority: t.priority ?? 1, key: `${t.id}:${ev.aggregate}` })
        }
      }
    },
  }
}
