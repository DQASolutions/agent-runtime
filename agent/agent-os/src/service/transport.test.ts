// DoD E ⭐ — the "ok for both horizons" proof: the SAME scenario driven through
// two transports (CLI arg-parse + a real HTTP server) hits the SAME
// `OsKernel.emitEvent` and produces IDENTICAL downstream state. If this passes,
// the Transport is a genuine port and the core is transport-agnostic.

import { describe, it, expect } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { createOntology, InMemoryAdapter } from '@dqa-ai-solutions/core-runtime'
import { GovernedOntologyPort, capabilityInterceptor } from '@dqa-ai-solutions/core-runtime'
import { Orchestrator, type WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'
import { InMemoryQueue } from '../queue/in-memory-queue.js'
import { OsKernel } from '../kernel/os-kernel.js'
import { Scheduler } from '../scheduler/scheduler.js'
import { TriggerRegistry } from '../triggers/trigger-def.js'
import { reactionInterceptor } from '../triggers/reaction-interceptor.js'
import { InteractiveDriver } from '../ports/driver.js'
import { OrchestratorSpawner } from '../spawner/orchestrator-spawner.js'
import { createEventServer } from './server.js'
import { parseEmitEventArgs } from './cli.js'

const ctx = { tenantId: 'default', actor: 'system' }

const demoReview: WorkflowV3 = {
  name: 'demo_review',
  version: 3,
  pipeline: [{ phase: 'main' }],
  phases: { main: { tasks: [{ id: 'review', type: 'agent-task', output: 'review.md', depends: [], instruction: 'Investigate the doc' }] } },
}

async function assemble(root: string) {
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
  return { inner, kernel, scheduler, spawner }
}

// Deterministic projection of "what happened" — instance ids (idFor is
// deterministic from type+ref), how many runs spawned, and the run's first task.
// Run ids themselves are NOT compared (they embed an event timestamp/seq).
async function snapshot(sys: Awaited<ReturnType<typeof assemble>>, root: string) {
  const docIds = (await sys.inner.find('demo_Doc', undefined, ctx)).map((d) => d.id).sort()
  const ref = sys.spawner.spawned[0]
  const next = ref ? await new Orchestrator(root, ref.tenant, demoReview, ref.runId).next() : null
  const firstTask = next && next.status === 'next' ? next.task : null
  return { docIds, spawnedCount: sys.spawner.spawned.length, firstTask }
}

const INPUT = { tenant: 'default', app: 'demo', action: 'demo_ingestDoc', params: { ref: 'D1', props: { title: 'x' } } }

describe('DoD E — one core, two transports, identical state', () => {
  it('CLI path and HTTP path produce the same downstream state', async () => {
    // (i) CLI transport: arg-parse → emitEvent
    const rootCli = await fs.mkdtemp(path.join(os.tmpdir(), 'os-cli-'))
    const sysCli = await assemble(rootCli)
    const cliInput = parseEmitEventArgs([
      '--tenant', 'default', '--app', 'demo', '--action', 'demo_ingestDoc', '--params', JSON.stringify(INPUT.params),
    ])
    await sysCli.kernel.emitEvent(cliInput)
    await sysCli.scheduler.drain()
    const snapCli = await snapshot(sysCli, rootCli)

    // (ii) HTTP transport: a real server → POST /events → emitEvent
    const rootHttp = await fs.mkdtemp(path.join(os.tmpdir(), 'os-http-'))
    const sysHttp = await assemble(rootHttp)
    const server = createEventServer(sysHttp.kernel)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    const resp = await fetch(`http://127.0.0.1:${port}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(INPUT),
    })
    expect(resp.status).toBe(202)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await sysHttp.scheduler.drain()
    const snapHttp = await snapshot(sysHttp, rootHttp)

    // e1: identical state from both transports
    expect(snapHttp).toEqual(snapCli)
    expect(snapCli.spawnedCount).toBe(1)
    expect(snapCli.firstTask).toBe('review')

    await fs.remove(rootCli)
    await fs.remove(rootHttp)
  })
})
