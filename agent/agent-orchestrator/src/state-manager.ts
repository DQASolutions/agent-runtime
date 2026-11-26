import fs from 'fs-extra'
import path from 'node:path'
import yaml from 'js-yaml'
import { glob } from 'glob'

/** Filename-safe slug: lowercase ASCII, runs of other chars → '-', max 32. */
function sanitize(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return cleaned || 'unknown'
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface RunMetadata {
  project: string
  run?: string
  workflow: string
  input?: string
  started: string
  startedBy?: string
  /** Composite this run belongs to, when spawned via `dqa start composite`. */
  composite?: string
  /**
   * Cross-run gate prereqs that must be approved before this run's first
   * task is dispatched. Populated from the composite manifest's depends-on
   * entries. Each entry references a sibling run id (NOT a workflow name)
   * and a gate id within that sibling run.
   */
  compositePrereqs?: Array<{ run: string; gate: string }>
}

export interface TaskEvent {
  task: string
  /**
   * `failed` = the step's executor threw.
   *
   * Deliberately a THIRD state, not a variant of `skipped`. `skipped` SATISFIES a dependency (the workflow
   * chose not to run that step, so downstream may proceed); `failed` must NOT — downstream would then read a
   * missing or stale artifact and write wrong data with no one the wiser. The whole point of recording it is
   * that a failure blocks exactly its own subtree and nothing else.
   */
  status: 'done' | 'skipped' | 'failed'
  at: string
  by?: string
  output?: string
  reason?: string
  /** message of the error that failed this step — the run report is useless without it */
  error?: string
  exports?: Record<string, unknown>
  /** Declared, typed structured outputs this step produced (see OutputsDecl). */
  outputs?: Record<string, unknown>
}

export interface GateEvent {
  gate: string
  status: 'passed'
  at: string
  by?: string
}

export interface WorkflowState {
  run: RunMetadata
  tasks: Record<string, TaskEvent>
  gates: Record<string, GateEvent>
  exports: Record<string, unknown>
  /**
   * Per-step structured outputs, keyed by step id: `outputs[stepId][field]`.
   * The canonical, typed view. Also mirrored into `exports[stepId]` (nested) so
   * expressions resolve `<stepId>.<field>` via the standard identifier path.
   */
  outputs: Record<string, Record<string, unknown>>
  skippedPhases: Set<string>
}

// ── State Directory ────────────────────────────────────────────────────────

export function getStateDir(frameworkRoot: string, project: string, run?: string): string {
  const dirName = run ? `${project}--${run}` : project
  return path.join(frameworkRoot, '.dqa', 'state', dirName)
}

// ── Init ───────────────────────────────────────────────────────────────────

export interface InitRunOptions {
  project: string
  run?: string
  workflow: string
  input?: string
  startedBy?: string
  composite?: string
  compositePrereqs?: Array<{ run: string; gate: string }>
}

export async function initRun(stateDir: string, opts: InitRunOptions): Promise<void> {
  const runFile = path.join(stateDir, '_run.yaml')

  if (await fs.pathExists(runFile)) {
    throw new Error(`Workflow run already exists at ${runFile}`)
  }

  await fs.mkdirp(stateDir)

  const metadata: RunMetadata = {
    project: opts.project,
    ...(opts.run ? { run: opts.run } : {}),
    workflow: opts.workflow,
    ...(opts.input ? { input: opts.input } : {}),
    started: new Date().toISOString(),
    ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
    ...(opts.composite ? { composite: opts.composite } : {}),
    ...(opts.compositePrereqs && opts.compositePrereqs.length > 0
      ? { compositePrereqs: opts.compositePrereqs }
      : {}),
  }

  await fs.writeFile(runFile, yaml.dump(metadata), 'utf-8')
}

// ── Write Events ───────────────────────────────────────────────────────────

export interface TaskDoneOptions {
  output: string
  by?: string
  exports?: Record<string, unknown>
  outputs?: Record<string, unknown>
}

/**
 * Build the per-event filename. When `by` is given, the file is named
 * `<id>.<kind>.<by>.yaml` so two devs completing the same task on parallel
 * branches produce different filenames — git merge keeps both records
 * instead of conflicting on one file. `loadState` resolves the latest by
 * `at` timestamp (last-writer-wins).
 *
 * Without `by`, falls back to the legacy `<id>.<kind>.yaml` so existing
 * state directories remain readable.
 */
function eventFilename(id: string, kind: 'done' | 'skipped' | 'failed' | 'approved', by?: string): string {
  if (!by) return `${id}.${kind}.yaml`
  return `${id}.${kind}.${sanitize(by)}.yaml`
}

export async function writeTaskDone(
  stateDir: string,
  phase: string,
  taskId: string,
  opts: TaskDoneOptions,
): Promise<void> {
  const phaseDir = path.join(stateDir, phase)
  await fs.mkdirp(phaseDir)

  const event: TaskEvent = {
    task: taskId,
    status: 'done',
    at: new Date().toISOString(),
    ...(opts.by ? { by: opts.by } : {}),
    output: opts.output,
    ...(opts.exports ? { exports: opts.exports } : {}),
    ...(opts.outputs ? { outputs: opts.outputs } : {}),
  }

  await fs.writeFile(
    path.join(phaseDir, eventFilename(taskId, 'done', opts.by)),
    yaml.dump(event),
    'utf-8',
  )
}

export async function writeTaskSkipped(
  stateDir: string,
  phase: string,
  taskId: string,
  reason: string,
): Promise<void> {
  const phaseDir = path.join(stateDir, phase)
  await fs.mkdirp(phaseDir)

  const event: TaskEvent = {
    task: taskId,
    status: 'skipped',
    at: new Date().toISOString(),
    reason,
  }

  // Skipped events are system-driven (when:-condition false), not user-driven,
  // so they don't carry a 'by' attribution and use the legacy single-file name.
  await fs.writeFile(
    path.join(phaseDir, eventFilename(taskId, 'skipped')),
    yaml.dump(event),
    'utf-8',
  )
}

/**
 * Record that a step's executor threw.
 *
 * Written to the same event log as done/skipped so a resumed run sees it: re-running must NOT silently retry
 * a step that failed, or a deterministic failure becomes an infinite loop.
 */
export async function writeTaskFailed(
  stateDir: string,
  phase: string,
  taskId: string,
  error: string,
): Promise<void> {
  const phaseDir = path.join(stateDir, phase)
  await fs.mkdirp(phaseDir)

  const event: TaskEvent = {
    task: taskId,
    status: 'failed',
    at: new Date().toISOString(),
    error,
  }

  await fs.writeFile(
    path.join(phaseDir, eventFilename(taskId, 'failed')),
    yaml.dump(event),
    'utf-8',
  )
}

export async function writeGateApproved(
  stateDir: string,
  phase: string,
  gateId: string,
  by?: string,
): Promise<void> {
  const phaseDir = path.join(stateDir, phase)
  await fs.mkdirp(phaseDir)

  const event: GateEvent = {
    gate: gateId,
    status: 'passed',
    at: new Date().toISOString(),
    ...(by ? { by } : {}),
  }

  await fs.writeFile(
    path.join(phaseDir, eventFilename(gateId, 'approved', by)),
    yaml.dump(event),
    'utf-8',
  )
}

export async function writePhaseSkipped(
  stateDir: string,
  phaseId: string,
  reason: string,
): Promise<void> {
  const event = {
    phase: phaseId,
    status: 'skipped',
    at: new Date().toISOString(),
    reason,
  }

  await fs.writeFile(
    path.join(stateDir, `${phaseId}.skipped.yaml`),
    yaml.dump(event),
    'utf-8',
  )
}

// ── Load State ─────────────────────────────────────────────────────────────

export async function loadState(stateDir: string): Promise<WorkflowState> {
  const runFile = path.join(stateDir, '_run.yaml')

  if (!(await fs.pathExists(runFile))) {
    throw new Error(`No _run.yaml found in ${stateDir}. Workflow not started.`)
  }

  const run = yaml.load(await fs.readFile(runFile, 'utf-8')) as RunMetadata

  const tasks: Record<string, TaskEvent> = {}
  const gates: Record<string, GateEvent> = {}
  const exports: Record<string, unknown> = {}
  const outputs: Record<string, Record<string, unknown>> = {}
  const skippedPhases = new Set<string>()

  // Glob matches both legacy `<id>.done.yaml` and per-dev `<id>.done.<by>.yaml`.
  // The `*` is greedy across dots, so the same pattern catches both shapes.
  // When multiple files exist for the same task (parallel devs merged via git),
  // the latest by `at` timestamp wins.
  const doneFiles = await glob('**/*.done*.yaml', { cwd: stateDir, nodir: true })
  const doneEvents: TaskEvent[] = []
  for (const file of doneFiles) {
    const content = yaml.load(await fs.readFile(path.join(stateDir, file), 'utf-8')) as TaskEvent
    doneEvents.push(content)
  }
  // Last-writer-wins per task: only the latest event contributes to state and exports.
  const latestDone = new Map<string, TaskEvent>()
  for (const evt of doneEvents) {
    const existing = latestDone.get(evt.task)
    if (!existing || existing.at < evt.at) latestDone.set(evt.task, evt)
  }
  for (const evt of latestDone.values()) {
    tasks[evt.task] = evt
    if (evt.exports) Object.assign(exports, evt.exports)
    if (evt.outputs) {
      // Canonical per-step view…
      outputs[evt.task] = { ...evt.outputs }
      // …and mirror into the exports namespace under the step id so existing
      // expression resolution handles `<step-id>.<field>` with no engine change.
      // A pre-existing flat export of the same name (rare) is preserved by
      // merging into it only when it is an object.
      const existing = exports[evt.task]
      exports[evt.task] =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>), ...evt.outputs }
          : { ...evt.outputs }
    }
  }

  // Scan failed files. A `done` for the same task WINS: a step that failed and was then re-run successfully
  // is done, full stop. The reverse (fail after done) cannot happen — a settled task is never dispatched.
  const failedFiles = await glob('**/*.failed.yaml', { cwd: stateDir, nodir: true })
  for (const file of failedFiles) {
    const content = yaml.load(await fs.readFile(path.join(stateDir, file), 'utf-8')) as TaskEvent
    if (content?.task && !tasks[content.task]) tasks[content.task] = content
  }

  // Scan skipped files (task-level and phase-level). Skipped events are
  // system-generated (no `by`), so they only have the legacy filename shape.
  const skippedFiles = await glob('**/*.skipped.yaml', { cwd: stateDir, nodir: true })
  for (const file of skippedFiles) {
    const content = yaml.load(await fs.readFile(path.join(stateDir, file), 'utf-8')) as Record<string, unknown>
    if (content.task) {
      // Don't overwrite a 'done' event with a 'skipped' one — done wins.
      const taskId = content.task as string
      if (!tasks[taskId]) tasks[taskId] = content as unknown as TaskEvent
    }
    if (content.phase) {
      skippedPhases.add(content.phase as string)
    }
  }

  // Scan approved files (legacy and per-dev shapes), last-writer-wins per gate.
  const approvedFiles = await glob('**/*.approved*.yaml', { cwd: stateDir, nodir: true })
  const approvedEvents: GateEvent[] = []
  for (const file of approvedFiles) {
    const content = yaml.load(await fs.readFile(path.join(stateDir, file), 'utf-8')) as GateEvent
    approvedEvents.push(content)
  }
  const latestApproved = new Map<string, GateEvent>()
  for (const evt of approvedEvents) {
    const existing = latestApproved.get(evt.gate)
    if (!existing || existing.at < evt.at) latestApproved.set(evt.gate, evt)
  }
  for (const evt of latestApproved.values()) {
    gates[evt.gate] = evt
  }

  return { run, tasks, gates, exports, outputs, skippedPhases }
}

// ── Project-level Exports Aggregation ──────────────────────────────────────

/**
 * Aggregate `exports` across every `<project>--<run>` state dir.
 *
 * Used by the bundle hand-off verifier so acceptance rules can reference
 * structured task verdicts (`cross_view_check.status == "PASS"`) instead
 * of grepping free-form markdown for sentinel strings. The single source
 * of truth is the `dqa done --exports` payload an agent writes when
 * completing a task; the verifier then reads from the same place the
 * workflow validator reads.
 *
 * Composite projects have multiple run dirs (`<project>--ba`,
 * `<project>--architect`, …). All are loaded and merged. Export keys are
 * task-namespaced by convention (`cross_view_check.status`,
 * `arch_acceptance_check.status`), so collisions across runs are rare —
 * when they happen, last-writer-wins by event `at` timestamp.
 *
 * Returns an empty object when no state dirs exist for the project.
 */
export async function loadProjectExports(
  frameworkRoot: string,
  project: string,
): Promise<Record<string, unknown>> {
  const stateRoot = path.join(frameworkRoot, '.dqa', 'state')
  if (!(await fs.pathExists(stateRoot))) return {}

  const safeProject = sanitize(project)
  // Composite-mode projects use `<project>--<run>` dirs (one per run id);
  // single-run legacy projects use a bare `<project>` dir. Cover both.
  const entries = await fs.readdir(stateRoot, { withFileTypes: true })
  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === safeProject || entry.name.startsWith(`${safeProject}--`)) {
      dirs.push(path.join(stateRoot, entry.name))
    }
  }
  if (dirs.length === 0) return {}

  // Collect all done events across all runs, then last-writer-wins per
  // task (by `at` timestamp). Same shape as loadState's done logic.
  type DoneEvt = TaskEvent & { _runDir: string }
  const allDone: DoneEvt[] = []
  for (const dir of dirs) {
    const files = await glob('**/*.done*.yaml', { cwd: dir, nodir: true })
    for (const file of files) {
      const content = yaml.load(await fs.readFile(path.join(dir, file), 'utf-8')) as TaskEvent
      allDone.push({ ...content, _runDir: dir })
    }
  }
  const latestPerTask = new Map<string, DoneEvt>()
  for (const evt of allDone) {
    // Key includes the run dir so the same task name in two different
    // runs (composite) doesn't collapse to one entry. The downstream
    // export merge still last-writer-wins on shared export keys.
    const key = `${evt._runDir}::${evt.task}`
    const existing = latestPerTask.get(key)
    if (!existing || existing.at < evt.at) latestPerTask.set(key, evt)
  }

  // Sort by `at` ascending so later events overwrite earlier ones on
  // shared export keys (rare in practice — task-namespaced keys avoid
  // most collisions — but explicit beats accidental).
  const sorted = [...latestPerTask.values()].sort((a, b) => (a.at < b.at ? -1 : 1))
  const merged: Record<string, unknown> = {}
  for (const evt of sorted) {
    if (evt.exports) Object.assign(merged, evt.exports)
  }
  return merged
}
