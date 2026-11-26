// Spawner — turns a spawn-run intent into a real run. A port so os-runtime's
// core does NOT hard-depend on the orchestrator's file machinery: tests use a
// fake; the real `OrchestratorSpawner` (calls `new Orchestrator(...).start()`)
// snaps in behind this interface (increment 2b). Per the locked invariant a
// Spawner ALWAYS starts a NEW run — it never barges into a running one.

import type { SpawnRunIntent } from './intent.js'
import type { RunRef } from './driver.js'

export interface Spawner {
  spawn(intent: SpawnRunIntent): Promise<RunRef>
}
