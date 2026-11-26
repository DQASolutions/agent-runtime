// Increment-2b proof: the REAL Spawner closes DoD A's a4 — a reaction spawns a
// live orchestrator run that `dqa next` can drive. Same fixture as the 2a loop,
// but FakeSpawner → OrchestratorSpawner (real `.dqa/state` run on disk).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import { createOntology, InMemoryAdapter } from '@dqa-ai-solutions/ontology-runtime'
import { GovernedOntologyPort, capabilityInterceptor } from '@dqa-ai-solutions/ontology-runtime'
import { Orchestrator, type WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'
import { InMemoryQueue } from '../queue/in-memory-queue.js'
import { OsKernel } from '../kernel/os-kernel.js'
import { Scheduler } from '../scheduler/scheduler.js'
import { TriggerRegistry } from '../triggers/trigger-def.js'
import { reactionInterceptor } from '../triggers/reaction-interceptor.js'
import { InteractiveDriver } from '../ports/driver.js'
import { OrchestratorSpawner } from './orchestrator-spawner.js'

const ctx = { tenantId: 'default', actor: 'system' }

// demo_review: one agent-task. `dqa next` should surface it.
const demoReview: WorkflowV3 = {
  name: 'demo_review',
  version: 3,
  pipeline: [{ phase: 'main' }],
  phases: {
    main: {
      tasks: [{ id: 'review', type: 'agent-task', output: 'review.md', depends: [], instruction: 'Investigate the doc' }],
    },
  },
}

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'os-rt-'))
})
afterEach(async () => {
  await fs.remove(root)
})

async function makeOntology() {
  const inner = createOntology({ adapter: new InMemoryAdapter() })
  await inner.defineEntityType({ name: 'demo_Doc', label: 'Doc', properties: [{ name: 'title', type: 'text' }] }, ctx)
  await inner.defineActionImpl(
    {
      def: { name: 'demo_ingestDoc', params: { ref: { type: 'string' }, props: { type: 'object', optional: true } } },
      effect: async (args, _c, io) => {
        const { id } = await io.upsert('demo_Doc', String(args.ref), (args.props as Record<string, unknown>) ?? {})
        return [{ type: 'demo:Doc.upserted', aggregate: id, payload: (args.props as never) ?? null }]
      },
    },
    ctx,
  )
  return inner
}

describe('DoD A (a4) — reaction spawns a REAL, driveable run', () => {
  it('emit → … → real run; `dqa next` returns its first task', async () => {
    const inner = await makeOntology()
    const queue = new InMemoryQueue()
    const registry = new TriggerRegistry()
    registry.register({
      id: 'demo:onDocUpserted',
      app: 'demo',
      on: { eventType: 'demo:Doc.upserted' },
      emit: { kind: 'spawn-run', workflow: 'demo_review', seed: (ev) => ({ docId: ev.aggregate }) },
      priority: 5,
    })
    const port = new GovernedOntologyPort(inner, [capabilityInterceptor(['demo_ingestDoc']), reactionInterceptor(registry, queue)])
    const spawner = new OrchestratorSpawner({ frameworkRoot: root, resolveWorkflow: (n) => (n === 'demo_review' ? demoReview : undefined) })
    const kernel = new OsKernel(queue)
    const scheduler = new Scheduler({ queue, port, spawner, driver: new InteractiveDriver(), now: () => '2026-06-15T00:00:00.000Z' })

    await kernel.emitEvent({ tenant: 'default', app: 'demo', action: 'demo_ingestDoc', params: { ref: 'D1', props: { title: 'x' } } })
    const res = await scheduler.drain()
    expect(res.failures).toEqual([])

    // a real run was spawned
    expect(spawner.spawned).toHaveLength(1)
    const ref = spawner.spawned[0]

    // a4: `dqa next` on the spawned run returns demo_review's first task
    const next = await new Orchestrator(root, ref.tenant, demoReview, ref.runId).next()
    expect(next.status).toBe('next')
    if (next.status === 'next') {
      expect(next.task).toBe('review')
      expect(next.instruction).toBe('Investigate the doc')
    }

    // the seed (docId) reached the run as its input
    const docs = await inner.find('demo_Doc', undefined, ctx)
    const runMeta = await fs.readFile(path.join(root, '.dqa', 'state', `default--${ref.runId}`, '_run.yaml'), 'utf-8')
    expect(runMeta).toContain(docs[0].id)
  })

  it('two reactions → two distinct runs (new run each, never barge-in)', async () => {
    const inner = await makeOntology()
    const queue = new InMemoryQueue()
    const registry = new TriggerRegistry()
    registry.register({
      id: 'demo:onDocUpserted',
      app: 'demo',
      on: { eventType: 'demo:Doc.upserted' },
      emit: { kind: 'spawn-run', workflow: 'demo_review' },
      priority: 5,
    })
    const port = new GovernedOntologyPort(inner, [capabilityInterceptor(['demo_ingestDoc']), reactionInterceptor(registry, queue)])
    const spawner = new OrchestratorSpawner({ frameworkRoot: root, resolveWorkflow: () => demoReview })
    const kernel = new OsKernel(queue)
    const scheduler = new Scheduler({ queue, port, spawner, driver: new InteractiveDriver(), now: () => '2026-06-15T00:00:00.000Z' })

    await kernel.emitEvent({ tenant: 'default', app: 'demo', action: 'demo_ingestDoc', params: { ref: 'D1', props: { title: 'a' } } })
    await kernel.emitEvent({ tenant: 'default', app: 'demo', action: 'demo_ingestDoc', params: { ref: 'D2', props: { title: 'b' } } })
    const res = await scheduler.drain()

    expect(res.failures).toEqual([])
    expect(spawner.spawned).toHaveLength(2)
    expect(new Set(spawner.spawned.map((r) => r.runId)).size).toBe(2) // distinct runs
  })
})
