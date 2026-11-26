// OrchestratorSpawner — the REAL Spawner: turns a spawn-run intent into a live
// orchestrator run on disk (`.dqa/state/<tenant>--<runId>`), driveable by
// `dqa next`. This is the ONLY file in os-runtime that depends on
// @dqa-ai-solutions/agent-orchestrator — the Spawner port keeps that dependency out of the core
// (queue · triggers · scheduler stay engine-agnostic).
//
// Per the locked invariant it ALWAYS starts a NEW run (start() → initRun, which
// throws if the run already exists) — never a barge-in.

import { Orchestrator, type WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'
import type { Spawner } from '../ports/spawner.js'
import type { SpawnRunIntent } from '../ports/intent.js'
import type { RunRef } from '../ports/driver.js'

export interface OrchestratorSpawnerOpts {
  /** Where run state lives (`<frameworkRoot>/.dqa/state/...`). */
  frameworkRoot: string
  /** Resolve a namespaced workflow name (e.g. `demo_review`) → its definition. */
  resolveWorkflow: (name: string) => WorkflowV3 | undefined
}

export class OrchestratorSpawner implements Spawner {
  /** Runs spawned this process (observability / tests). */
  readonly spawned: RunRef[] = []

  constructor(private readonly opts: OrchestratorSpawnerOpts) {}

  async spawn(intent: SpawnRunIntent): Promise<RunRef> {
    const wf = this.opts.resolveWorkflow(intent.workflow)
    if (!wf) throw new Error(`OrchestratorSpawner: unknown workflow "${intent.workflow}"`)

    // Run id derived from the (deterministic) intent id, sanitized to a safe
    // directory component. Tenant is the orchestrator "project".
    const runId = intent.id.replace(/[^A-Za-z0-9_]/g, '_')
    const orch = new Orchestrator(this.opts.frameworkRoot, intent.tenant, wf, runId)

    // start() = initRun (NEW run) + first next(); the reaction's seed becomes the
    // run input so the driven session has its context.
    await orch.start({ input: JSON.stringify(intent.seed) })

    const ref: RunRef = { runId, workflow: intent.workflow, tenant: intent.tenant }
    this.spawned.push(ref)
    return ref
  }
}
