// WorkflowRunner — lets the ENGINE drive a workflow whose steps are executed by
// registered StepExecutors, instead of an external caller hand-driving
// next/done. A step declares `uses: <executor-name>` (+ declarative `with`
// params); the runner looks the executor up, runs it, records its result as the
// step's structured outputs, and advances — stopping (or auto-approving) at
// gates. This is what keeps an app declarative: the app ships workflow + rules,
// the kernel runs them. Executors that touch a domain (e.g. the ontology) are
// injected by the consumer, so the engine itself stays domain-neutral.

import type { Orchestrator, NextResult, NextTaskPayload } from './orchestrator.js'

export interface StepContext {
  /** The full step payload — includes `uses`, `with`, `outputs`, `instruction`. */
  task: NextTaskPayload
  /** The run's input (from `dqa start --input` / startRun). */
  input?: string
  /** Absolute project base dir, for executors that write files. */
  projectBaseDir: string
  /** The app's declared default profile/mode (app.yaml → `profile`), threaded
   *  in so executors share ONE source of truth instead of each hardcoding a
   *  default. A step's own `with.profile` still overrides this. */
  profile?: string
}

export interface StepResult {
  /** Values recorded at `done` — declared structured outputs (#1) + free exports. */
  exports?: Record<string, unknown>
}

export interface StepExecutor {
  run(ctx: StepContext): Promise<StepResult>
}

/** Registry keyed by the step's `uses` name. */
export type ExecutorRegistry = Record<string, StepExecutor>

export interface RunOptions {
  input?: string
  by?: string
  /** Called when a gate is reached. Return true to approve and continue, false
   *  to stop and return the `waiting` result. Default: stop. */
  onGate?: (gate: string, description: string) => boolean | Promise<boolean>
  maxSteps?: number
}

export class WorkflowRunner {
  constructor(
    private readonly orch: Orchestrator,
    private readonly executors: ExecutorRegistry,
    /** app-level StepContext defaults (e.g. `profile` from app.yaml), merged
     *  into every step's context. */
    private readonly ctxDefaults: { profile?: string } = {},
  ) {}

  /** Drive the run to completion (or to a gate that is not approved). */
  async run(opts: RunOptions = {}): Promise<NextResult> {
    let res = await this.orch.start({ input: opts.input, startedBy: opts.by })
    const max = opts.maxSteps ?? 1000

    for (let i = 0; i < max; i++) {
      if (res.status === 'next') {
        const exports = await this.execute(res, opts.input)
        res = await this.orch.done(res.task, { exports, by: opts.by })
      } else if (res.status === 'next-batch') {
        for (const t of res.tasks) {
          const exports = await this.execute(t, opts.input)
          res = await this.orch.done(t.task, { exports, by: opts.by })
        }
      } else if (res.status === 'waiting') {
        const approve = opts.onGate ? await opts.onGate(res.gate, res.description) : false
        if (!approve) return res
        res = await this.orch.approve(res.gate, opts.by ? { by: opts.by } : undefined)
      } else {
        return res // complete | blocked
      }
    }
    throw new Error(`WorkflowRunner exceeded maxSteps (${max})`)
  }

  private async execute(task: NextTaskPayload, input?: string): Promise<Record<string, unknown> | undefined> {
    const uses = task.uses
    if (!uses) {
      throw new Error(`step "${task.task}" has no \`uses\` executor — the runner only drives executor-backed steps`)
    }
    const exec = this.executors[uses]
    if (!exec) {
      throw new Error(`no StepExecutor registered for \`uses: ${uses}\` (step "${task.task}")`)
    }
    const result = await exec.run({ task, input, projectBaseDir: task.project_base_dir, profile: this.ctxDefaults.profile })
    return result.exports
  }
}
