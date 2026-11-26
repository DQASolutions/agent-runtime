// TriggerDef + registry — the declarative "when an event happens, start this".
// slice A: match on event type, emit a spawn-run. Subscriptions are EXPLICIT
// (declared, not ambient) so the same mechanism scales to cross-app
// choreography later (os-runtime-design.md §7).

import type { OntologyEvent } from '@dqa-ai-solutions/ontology-runtime'

export interface TriggerDef {
  /** Namespaced id, e.g. `demo:onDocUpserted`. */
  id: string
  /** App that owns this trigger. */
  app: string
  /** Match condition. slice A: by event type (namespaced, e.g. `demo:Doc.upserted`). */
  on: { eventType: string }
  /** What to do on match. slice A: spawn a NEW run (never barge-in). */
  emit: {
    kind: 'spawn-run'
    /** Namespaced workflow to start, e.g. `demo:review`. */
    workflow: string
    /** Map the firing event → the run's seed context. */
    seed?: (event: OntologyEvent) => Record<string, unknown>
  }
  /** Priority for the enqueued reaction (higher = sooner). Default 1. */
  priority?: number
}

export class TriggerRegistry {
  private readonly byEventType = new Map<string, TriggerDef[]>()

  register(t: TriggerDef): void {
    const list = this.byEventType.get(t.on.eventType) ?? []
    list.push(t)
    this.byEventType.set(t.on.eventType, list)
  }

  /** Triggers whose `on` matches this event. */
  match(event: OntologyEvent): TriggerDef[] {
    return this.byEventType.get(event.type) ?? []
  }
}
