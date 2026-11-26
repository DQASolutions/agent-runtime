// Demo service entrypoint — the always-on, non-LLM tier as a standalone
// process: HTTP ingress (POST /events) + a drain loop (the scheduler). This is
// the "service-skeleton" that runs in Docker (DoD F). It wires the `demo` app;
// a real deployment swaps this composition root for an installed app's wiring.
//
// Run: `PORT=8080 node dist/service/main.js`

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createOntology, InMemoryAdapter } from '@dqa-ai-solutions/ontology-runtime'
import { GovernedOntologyPort, capabilityInterceptor } from '@dqa-ai-solutions/ontology-runtime'
import type { WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'
import { InMemoryQueue } from '../queue/in-memory-queue.js'
import { OsKernel } from '../kernel/os-kernel.js'
import { Scheduler } from '../scheduler/scheduler.js'
import { TriggerRegistry } from '../triggers/trigger-def.js'
import { reactionInterceptor } from '../triggers/reaction-interceptor.js'
import { InteractiveDriver } from '../ports/driver.js'
import { OrchestratorSpawner } from '../spawner/orchestrator-spawner.js'
import { createEventServer } from './server.js'

const ctx = { tenantId: 'default', actor: 'system' }

const demoReview: WorkflowV3 = {
  name: 'demo_review',
  version: 3,
  'schema-version': '3.1',
  produces: [],
  consumes: [],
  pipeline: [{ phase: 'main' }],
  phases: { main: { tasks: [{ id: 'review', type: 'agent-task', output: 'review.md', depends: [], instruction: 'Investigate the doc' }] } },
}

async function main(): Promise<void> {
  const stateRoot = process.env.STATE_DIR ?? path.join(os.tmpdir(), 'os-runtime-state')
  await mkdir(stateRoot, { recursive: true })

  // ── Wire the demo app onto the kernel ────────────────────────────────────
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
  const spawner = new OrchestratorSpawner({ frameworkRoot: stateRoot, resolveWorkflow: (n) => (n === 'demo_review' ? demoReview : undefined) })
  const kernel = new OsKernel(queue)
  const scheduler = new Scheduler({ queue, port, spawner, driver: new InteractiveDriver() })

  // ── Always-on drain loop (the non-LLM nervous system) ────────────────────
  const tick = setInterval(() => {
    void scheduler.drain()
  }, 50)

  // ── HTTP ingress + observable state ──────────────────────────────────────
  const server = createEventServer(kernel, {
    snapshot: async () => ({
      docs: (await inner.find('demo_Doc', undefined, ctx)).length,
      runs: spawner.spawned.length,
    }),
  })
  const listenPort = Number(process.env.PORT ?? 8080)
  server.listen(listenPort, () => {
    console.log(`[os-runtime] demo service listening on :${listenPort} (state: ${stateRoot})`)
  })

  const shutdown = (): void => {
    clearInterval(tick)
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main()
