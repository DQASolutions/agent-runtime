// Driver — the ONLY thing that needs a Claude session (os-runtime-design.md §4).
// A port: slice A ships InteractiveDriver (no-op — a human drives the run via
// `dqa next`); later HeadlessDriver spawns `claude -p` to drive the run's
// `next → do task → done` loop to a gate or completion. Same interface either
// way, so the scheduler never changes.

/** Reference to a freshly-spawned run that needs driving. */
export interface RunRef {
  runId: string
  workflow: string
  tenant: string
}

export interface Driver {
  /** Drive `run` to its next human gate or to completion. */
  drive(run: RunRef): Promise<void>
}

/**
 * slice A driver: a NO-OP. The spawned run already exists in the ready-set; a
 * human/interactive session drives it via `dqa next --tenant <runId>`. We model
 * it as a Driver so the scheduler is written once and HeadlessDriver drops in
 * later with zero scheduler changes.
 */
export class InteractiveDriver implements Driver {
  async drive(_run: RunRef): Promise<void> {
    // intentionally empty — a person/session pulls the run.
  }
}
