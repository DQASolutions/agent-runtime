// @dqa-ai-solutions/agent-os — the always-on, non-LLM kernel tier. See
// docs/os-runtime-design.md for the full design (3 ports · 3 ways into the
// kernel · slice-A DoD A–F).

// Ports (the plug-in seams: Transport · WorkQueue · Driver · Spawner)
export type { Intent, IntentKind, IngestIntent, SpawnRunIntent } from './ports/intent.js'
export type { WorkQueue, EnqueueOpts } from './ports/work-queue.js'
export type { Driver, RunRef } from './ports/driver.js'
export { InteractiveDriver } from './ports/driver.js'
export type { Spawner } from './ports/spawner.js'
export { OrchestratorSpawner, type OrchestratorSpawnerOpts } from './spawner/orchestrator-spawner.js'
export type { Kernel, IngressInput } from './ports/transport.js'

// Impls
export { InMemoryQueue, type InMemoryQueueOpts } from './queue/in-memory-queue.js'
export { OsKernel, type OsKernelOpts } from './kernel/os-kernel.js'
export { Scheduler, type SchedulerDeps, type DrainResult } from './scheduler/scheduler.js'

// Triggers / reaction
export { TriggerRegistry, type TriggerDef } from './triggers/trigger-def.js'
export { reactionInterceptor } from './triggers/reaction-interceptor.js'

// Transports (thin adapters over Kernel.emitEvent)
export { createEventServer } from './service/server.js'
export { parseEmitEventArgs, runEmitEvent } from './service/cli.js'
