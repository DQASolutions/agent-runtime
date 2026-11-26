// Increment-2 proof: the OS-runtime reaction loop end-to-end against a REAL
// ontology + governed write door.
//
//   emit-event → enqueue(ingest) → drain → applyAction (governed) → event
//                → reactionInterceptor matches trigger → enqueue(spawn-run)
//                → drain → Spawner (NEW run)
//
// Covers DoD A (spine), B (coalescing end-to-end), D (single governed door).
// a4 (`dqa next` returns the first task of a REAL run) is increment 2b — here
// the Spawner is faked, so a3/a5 are proven (a NEW run is spawned, nothing
// existing is touched: there is no barge-in code path at all).

import { describe, it, expect } from 'vitest'
import { createOntology, InMemoryAdapter } from '@dqa-ai-solutions/core-runtime'
import { GovernedOntologyPort, capabilityInterceptor } from '@dqa-ai-solutions/core-runtime'
import { InMemoryQueue } from '../queue/in-memory-queue.js'
import { OsKernel } from '../kernel/os-kernel.js'
import { Scheduler } from '../scheduler/scheduler.js'
import { TriggerRegistry } from '../triggers/trigger-def.js'
import { reactionInterceptor } from '../triggers/reaction-interceptor.js'
import { InteractiveDriver } from '../ports/driver.js'
import type { Spawner } from '../ports/spawner.js'
import type { SpawnRunIntent } from '../ports/intent.js'
import type { RunRef } from '../ports/driver.js'

const ctx = { tenantId: 'default', actor: 'system' }

// Records spawned runs; the real OrchestratorSpawner snaps in behind this port
// (increment 2b). Only ever CREATES — there is no mutate-existing-run method.
class FakeSpawner implements Spawner {
  readonly spawned: SpawnRunIntent[] = []
  async spawn(intent: SpawnRunIntent): Promise<RunRef> {
    this.spawned.push(intent)
    return { runId: `run-${this.spawned.length}`, workflow: intent.workflow, tenant: intent.tenant }
  }
}

// The `demo` fixture app: one type, one action (emits a namespaced event), one
// trigger (event → spawn `demo:review`).
async function makeSystem() {
  const inner = createOntology({ adapter: new InMemoryAdapter() })
  await inner.defineEntityType(
    { name: 'demo_Doc', label: 'Doc', properties: [{ name: 'title', type: 'text' }, { name: 'n', type: 'number' }] },
    ctx,
  )
  await inner.defineActionImpl(
    {
      def: { name: 'demo_ingestDoc', params: { ref: { type: 'string' }, props: { type: 'object', optional: true } } },
      effect: async (args, _c, io) => {
        const { id } = await io.upsert('demo_Doc', String(args.ref), (args.props as Record<string, unknown>) ?? {})
        return [{ type: 'demo_Doc.upserted', aggregate: id, payload: (args.props as never) ?? null }]
      },
    },
    ctx,
  )

  const queue = new InMemoryQueue()
  const registry = new TriggerRegistry()
  registry.register({
    id: 'demo:onDocUpserted',
    app: 'demo',
    on: { eventType: 'demo_Doc.upserted' },
    emit: { kind: 'spawn-run', workflow: 'demo:review', seed: (ev) => ({ docId: ev.aggregate }) },
    priority: 5,
  })

  // Governed door: only `demo_ingestDoc` is granted (DoD D) + reaction hook.
  const port = new GovernedOntologyPort(inner, [
    capabilityInterceptor(['demo_ingestDoc']),
    reactionInterceptor(registry, queue),
  ])

  const spawner = new FakeSpawner()
  const kernel = new OsKernel(queue)
  const scheduler = new Scheduler({
    queue,
    port,
    spawner,
    driver: new InteractiveDriver(),
    now: () => '2026-06-15T00:00:00.000Z',
  })
  return { inner, queue, kernel, scheduler, spawner }
}

describe('DoD A — one external input → one new run (the spine)', () => {
  it('emit → action → event → trigger → spawn (new run)', async () => {
    const { inner, kernel, scheduler, spawner } = await makeSystem()

    await kernel.emitEvent({ tenant: 'default', app: 'demo', action: 'demo_ingestDoc', params: { ref: 'D1', props: { title: 'x' } } })
    const res = await scheduler.drain()

    expect(res.failures).toEqual([])
    expect(res.processed).toBe(2) // ingest + spawn-run

    // a1: exactly one Doc, created through the Action door
    const docs = await inner.find('demo_Doc', undefined, ctx)
    expect(docs).toHaveLength(1)

    // a3: exactly one NEW run spawned, seeded from the event
    expect(spawner.spawned).toHaveLength(1)
    const sr = spawner.spawned[0]
    expect(sr.workflow).toBe('demo:review')
    expect(sr.seed).toEqual({ docId: docs[0].id })

    // a2: the reaction carries the causation chain (caused by the event) + app
    expect(sr.app).toBe('demo')
    expect(sr.causationId).toBeDefined()
    expect(sr.depth).toBe(1)
  })
})

describe('DoD B — coalescing end-to-end', () => {
  it('100 identical external inputs collapse to ONE Doc and ONE run', async () => {
    const { inner, queue, kernel, scheduler, spawner } = await makeSystem()

    for (let n = 0; n < 100; n++) {
      await kernel.emitEvent({ tenant: 'default', app: 'demo', action: 'demo_ingestDoc', params: { ref: 'D1', props: { n } } })
    }
    expect(queue.size()).toBe(1) // ingest coalesced before any draining

    await scheduler.drain()
    expect(await inner.find('demo_Doc', undefined, ctx)).toHaveLength(1) // b1
    expect(spawner.spawned).toHaveLength(1) // b2
  })
})

describe('DoD D — the single governed door', () => {
  it('an ungranted action is rejected at the door; no write, no run', async () => {
    const { inner, kernel, scheduler, spawner } = await makeSystem()

    await kernel.emitEvent({ tenant: 'default', app: 'demo', action: 'demo:evilWrite', params: { ref: 'X' } })
    const res = await scheduler.drain()

    expect(res.processed).toBe(0)
    expect(res.failures).toHaveLength(1)
    expect(String(res.failures[0].error)).toMatch(/capabilit/i)
    expect(await inner.find('demo_Doc', undefined, ctx)).toHaveLength(0) // no write
    expect(spawner.spawned).toHaveLength(0) // no reaction, no run
  })
})
