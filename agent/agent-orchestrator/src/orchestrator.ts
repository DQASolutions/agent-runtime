import fs from 'fs-extra'
import path from 'node:path'
import { glob } from 'glob'
import yaml from 'js-yaml'
import type { WorkflowV3, PipelineEntry, OutputsDecl } from './schema-types-v3.js'
import { validateOutputs, formatOutputErrors } from './output-schema.js'

/** Common task fields accessible via record access */
type AnyTask = Record<string, unknown> & { id: string; type?: string; depends?: string[] }
import {
  getStateDir,
  initRun,
  loadState,
  writeTaskDone,
  writeTaskSkipped,
  writeTaskFailed,
  writeGateApproved,
  writePhaseSkipped,
  type WorkflowState,
} from './state-manager.js'
import { evaluateExpression, isDefinedIdentifier, type ExpressionContext, type RunSnapshot } from './expression-engine.js'
import { isStub } from './stub.js'

// ── Result Types ───────────────────────────────────────────────────────────

export interface NextTaskPayload {
  task: string
  phase: string
  type: string
  instruction?: string
  guidance?: string
  guardrails?: string[]
  output: string
  /** Declared structured outputs this step must return (so the agent knows
   *  which typed fields to emit, via frontmatter or `dqa done --exports`). */
  outputs?: OutputsDecl
  /** Registered StepExecutor name + its declarative params — when set, the
   *  engine (a WorkflowRunner) executes this step instead of the caller. */
  uses?: string
  with?: Record<string, unknown>
  depends: Array<{ id: string; status: string; path?: string }>
  context: { files: string[] }
  /**
   * Anthropic model tier for the subagent. Pass-through from the task
   * YAML's `model:` field. When undefined the CLAUDE.md briefing template
   * tells Claude to default to "sonnet" — see "Subagent model selection"
   * section in CLAUDE.md.
   */
  model?: 'sonnet' | 'opus' | 'haiku'
  /**
   * Absolute path to the DQA project base directory.
   * Always included so workflow scripts can resolve relative paths without
   * any path algebra.
   */
  project_base_dir: string
}

export type NextResult =
  | ({ status: 'next' } & NextTaskPayload)
  | { status: 'next-batch'; phase: string; tasks: NextTaskPayload[] }
  | { status: 'waiting'; gate: string; type: 'approval'; description: string }
  | { status: 'blocked'; gate: string; check: string; currentValue: unknown; suggestion: string }
  | {
      status: 'complete'
      summary: {
        phases: number
        tasksDone: number
        tasksSkipped: number
        /** present ONLY when steps failed — absence means a clean run, so callers can test truthiness */
        tasksFailed?: Array<{ task: string; error: string }>
      }
    }

export interface StartOptions {
  input?: string
  startedBy?: string
  exports?: Record<string, unknown>
}

export interface DoneOptions {
  exports?: Record<string, unknown>
  by?: string
  /** Return the next-batch shape with up to N ready agent-tasks instead
   *  of a single next-task — lets the caller dispatch all of them in
   *  parallel without a separate `dqa next --parallel` roundtrip. */
  parallel?: number
}

export interface ApproveOptions {
  by?: string
  /** See DoneOptions.parallel. */
  parallel?: number
}

// ── For-each expansion ────────────────────────────────────────────────────

interface ExpandedTask extends AnyTask {
  /** The for-each parent task id */
  _forEachParent?: string
  /** The matched file/item this task was expanded from */
  _forEachItem?: string
  /** Item-level variables from the for-each expansion (e.g. story.id, story.path).
   *  Merged into vars when resolving file-based task instructions so that
   *  placeholders like {story.id} in .md files are substituted correctly. */
  _itemVars?: Record<string, string>
}

// ── Output file export parser ──────────────────────────────────────────────

/**
 * Parse a task output file and extract its top-level YAML/JSON object so
 * validate expressions like `task_id.field == value` can evaluate against
 * content the subagent wrote. Handles YAML frontmatter (--- block ---) and
 * raw .yaml/.yml/.json files. Returns null if the file cannot be parsed.
 */
async function parseOutputExports(filePath: string): Promise<Record<string, unknown> | null> {
  if (!(await fs.pathExists(filePath))) return null
  const content = await fs.readFile(filePath, 'utf-8').catch(() => null)
  if (!content) return null

  // YAML frontmatter: ^--- ... ---
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fmMatch) {
    try {
      const parsed = yaml.load(fmMatch[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* malformed frontmatter — fall through */ }
  }

  // Raw YAML/JSON (only for those extensions — avoids mis-parsing prose .md)
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
    try {
      const parsed = ext === '.json' ? JSON.parse(content) : yaml.load(content)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* not valid YAML/JSON */ }
  }

  return null
}

/**
 * A step is SETTLED once it will not be dispatched again this run.
 *
 * Distinct from SATISFIES-A-DEPENDENCY on purpose — that is `done || skipped`, and `failed` is deliberately
 * absent from it. Conflating the two is the bug this pair of helpers exists to prevent: treat `failed` as
 * unsettled and the run retries forever; treat it as satisfying and downstream steps run on data that was
 * never produced.
 */
const isSettled = (s?: string): boolean => s === 'done' || s === 'skipped' || s === 'failed'

/** Dependency satisfaction. `failed` is NOT here, and must never be added. */
const satisfiesDep = (s?: string): boolean => s === 'done' || s === 'skipped'

// ── Orchestrator ───────────────────────────────────────────────────────────

export class Orchestrator {
  private frameworkRoot: string
  private project: string
  private workflow: WorkflowV3
  private stateDir: string
  private projectDir: string
  private run?: string

  constructor(frameworkRoot: string, project: string, workflow: WorkflowV3, run?: string) {
    this.frameworkRoot = frameworkRoot
    this.project = project
    this.workflow = workflow
    this.run = run
    this.stateDir = getStateDir(frameworkRoot, project, run)
    this.projectDir = path.join(frameworkRoot, '.dqa', 'projects', project)
  }

  // ── start ──────────────────────────────────────────────────────────────

  async start(opts?: StartOptions): Promise<NextResult> {
    // Check prereq
    if (this.workflow.prereq) {
      const exprCtx = this.makeExprContext({}, opts?.exports)
      const { value, resolved } = await this.evaluateResolved(this.workflow.prereq, exprCtx)
      if (!value) {
        throw new Error(`Workflow prereq not met: ${resolved}`)
      }
    }

    await initRun(this.stateDir, {
      project: this.project,
      run: this.run,
      workflow: this.workflow.name,
      input: opts?.input,
      startedBy: opts?.startedBy,
    })

    // If initial exports provided, write a synthetic done event
    if (opts?.exports) {
      await writeTaskDone(this.stateDir, '_init', '_bootstrap', {
        output: '',
        exports: opts.exports,
        ...(opts.startedBy ? { by: opts.startedBy } : {}),
      })
    }

    return this.next()
  }

  // ── next ───────────────────────────────────────────────────────────────

  async next(opts?: { absolutePaths?: boolean }): Promise<NextResult> {
    const result = await this.nextInternal(1)
    return opts?.absolutePaths ? this.resolveResultPaths(result) : result
  }

  /**
   * Return up to `maxParallel` agent-tasks that are ready right now, so the
   * caller can dispatch them in parallel (e.g. one subagent per task). Tasks
   * are ready iff their declared dependencies are done — two tasks returned
   * in the same batch are, by construction, mutually independent.
   *
   * Non-agent work (gates, actions, checks) is never batched; if the scan
   * hits one before filling the batch it stops early and that single item
   * is returned on the next call instead.
   */
  async nextBatch(maxParallel = 5, opts?: { absolutePaths?: boolean }): Promise<NextResult> {
    if (maxParallel < 1) throw new Error(`maxParallel must be >= 1, got ${maxParallel}`)
    const result = await this.nextInternal(maxParallel)
    return opts?.absolutePaths ? this.resolveResultPaths(result) : result
  }

  private async nextInternal(maxAgentBatch: number, absolutePaths = false): Promise<NextResult> {
    const state = await loadState(this.stateDir)

    // Composite prereq enforcement — pull mode. When this run was spawned
    // from a composite manifest, its `_run.yaml` carries `compositePrereqs`
    // (cross-run gates that must be approved upstream). Enforce before
    // dispatching any task so role workflows don't race ahead of their
    // prerequisite hand-offs.
    const prereqBlock = await this.checkCompositePrereqs(state)
    if (prereqBlock) return prereqBlock

    const pipeline = this.workflow.pipeline
    const phases = this.workflow.phases

    const currentPhaseId = await this.findCurrentPhase(state, pipeline)
    if (!currentPhaseId) {
      return this.completeWorkflow(state)
    }

    const phaseBody = phases[currentPhaseId]
    if (!phaseBody) {
      return this.completeWorkflow(state)
    }

    const expandedTasks = await this.expandTasks(phaseBody.tasks as AnyTask[], state)
    // Derive compound-parent completion from current state BEFORE dispatching:
    // a for-each/parallel/switch parent (or a nested for-each marker) whose
    // children are all done is marked done here, cascading outward. Doing it
    // on every next() — not only on the triggering done() — means a trailing
    // approved GATE completes its parent too (approve() never ran the old
    // done()-side rollup).
    await this.reconcileCompletions(expandedTasks, currentPhaseId, state)
    const taskResult = await this.findReadyTask(expandedTasks, currentPhaseId, state, maxAgentBatch)
    if (taskResult) return taskResult

    // If findReadyTask returned nothing but the phase still has unfinished
    // work, something can't progress automatically — typically a for-each task
    // whose source glob currently matches 0 files (its producing step hasn't
    // emitted them yet, or it's genuinely empty). Surface this as `blocked`,
    // NOT `complete`: previously this returned `complete`, which contradicted
    // `dqa status` (still 'running') and could mislead an orchestrator into
    // stopping the run early. `blocked` keeps next ⇆ status consistent and
    // names what's stuck; nothing is persisted, so a later next() re-expands
    // once the source appears.
    // A phase whose remaining work is all SETTLED — including failures — has nothing left to dispatch, so it
    // must advance. Counting only done/skipped would strand the run on a failed step forever and report the
    // for-each message below, which names the wrong cause entirely.
    const phaseDone = (phaseBody.tasks as AnyTask[]).every(t => isSettled(state.tasks[t.id]?.status))
    if (!phaseDone) {
      // A step blocked behind a FAILED dependency is the likeliest cause now, and it has a precise answer.
      // Report that before falling back to the for-each guess.
      const blockedByFailure = (phaseBody.tasks as AnyTask[])
        .filter(t => !isSettled(state.tasks[t.id]?.status))
        .flatMap(t => (t.depends ?? []).filter(d => state.tasks[d]?.status === 'failed').map(d => ({ task: t.id, dep: d })))
      if (blockedByFailure.length > 0) {
        const failedDeps = [...new Set(blockedByFailure.map(b => b.dep))]
        return {
          status: 'blocked',
          gate: '_step-failed',
          check: `${failedDeps.length} step(s) failed: ${failedDeps.join(', ')}`,
          currentValue: failedDeps.map(d => `${d}: ${state.tasks[d]?.error ?? ''}`).join(' | '),
          suggestion: `${blockedByFailure.length} downstream step(s) cannot run until the failed step(s) succeed. Fix the cause, then re-run — settled steps are not re-dispatched, so only the failed step and its subtree run again.`,
        }
      }
      const stuck = expandedTasks.find(t => (t as AnyTask).type === 'for-each') as AnyTask | undefined
      const which = stuck ? `for-each "${stuck.id}"` : `phase "${currentPhaseId}"`
      return {
        status: 'blocked',
        gate: '_for-each-empty',
        check: `${which} has no ready work — its source matched 0 items`,
        currentValue: 'pending',
        suggestion: `The for-each source produced 0 items. Emit the source files it iterates, then re-run dqa next. If the for-each is genuinely empty, remove it or gate it with a when: condition.`,
      }
    }

    return this.advanceToNextPhase(state, pipeline, currentPhaseId, maxAgentBatch)
  }

  // ── done ───────────────────────────────────────────────────────────────

  async done(taskId: string, opts?: DoneOptions): Promise<NextResult> {
    const state = await loadState(this.stateDir)
    const currentPhaseId = await this.findCurrentPhase(state, this.workflow.pipeline)

    // Find task definition — check both static and expanded tasks
    let task = this.findTaskInWorkflow(taskId)

    // If not found in static workflow, it might be an expanded for-each sub-task
    if (!task) {
      const phaseBody = currentPhaseId ? this.workflow.phases[currentPhaseId] : null
      if (phaseBody) {
        const expanded = await this.expandTasks(phaseBody.tasks as AnyTask[], state)
        task = expanded.find(t => t.id === taskId)
      }
    }

    if (!task) throw new Error(`Task "${taskId}" not found in workflow`)

    // Build resolved vars from merged exports (state + opts) for template resolution
    const mergedExprCtx = this.makeExprContext(state.exports, opts?.exports)
    const vars = { workspace: this.frameworkRoot, 'project-dir': this.projectDir, ...this.exportVarsAsStrings(mergedExprCtx.exports ?? {}) }

    // Verify output exists (for agent-tasks)
    if (task.type === 'agent-task' || !task.type) {
      const rawOutput = task.output as string | string[] | undefined
      const rawOutputs = rawOutput === undefined
        ? []
        : Array.isArray(rawOutput) ? rawOutput : [rawOutput]
      const outputs = rawOutputs.map(o => this.resolveVars(o, vars))

      for (const output of outputs) {
        if (!output.includes('*') && !output.includes('{')) {
          const outputPath = path.isAbsolute(output) ? output : path.join(this.projectDir, output)
          if (!(await fs.pathExists(outputPath))) {
            throw new Error(`Output file not found: ${output}. Task "${taskId}" cannot be marked done.`)
          }
          if (await isStub(outputPath)) {
            throw new Error(
              `Output "${output}" contains placeholder content. Task "${taskId}" cannot be marked done until the file is fully implemented.`
            )
          }
        } else {
          // Glob output — check minimum match count
          // For absolute paths, glob ignores cwd — pass undefined to avoid confusion
          // nocase: tolerate case drift in artefact names (e.g. STORY-001.md
          // vs story-001.md) — discovery must not fail on case-sensitive FS.
          const globOpts = path.isAbsolute(output.replace(/\*.*$/, ''))
            ? { nodir: true, nocase: true }
            : { cwd: this.projectDir, nodir: true, nocase: true }
          const matches = await glob(output, globOpts)
          const minCount = (task['min-output-count'] as number | undefined) ?? 1

          // Only count files written after the run started (prevents pre-existing files from satisfying the check).
          // _run.yaml is YAML — must yaml.load it; fs.readJSON would always throw and silently disable this guard.
          const runMeta = await fs
            .readFile(path.join(this.stateDir, '_run.yaml'), 'utf-8')
            .then((raw) => yaml.load(raw) as { started?: string } | null)
            .catch(() => null)
          const runStartedMs = runMeta?.started ? new Date(runMeta.started).getTime() : 0
          const freshMatches: string[] = []
          for (const match of matches) {
            const full = path.isAbsolute(match) ? match : path.join(this.projectDir, match)
            const stat = await fs.stat(full).catch(() => null)
            if (stat && stat.mtimeMs >= runStartedMs) freshMatches.push(match)
          }

          if (freshMatches.length < minCount) {
            throw new Error(
              `Found ${freshMatches.length} new file(s) matching "${output}" written since run started (minimum: ${minCount}). ` +
              `${matches.length - freshMatches.length} pre-existing file(s) were excluded. Task "${taskId}" cannot be marked done.`
            )
          }
          // Stub check — reject placeholder/unimplemented files
          for (const match of freshMatches) {
            const full = path.isAbsolute(match) ? match : path.join(this.projectDir, match)
            if (await isStub(full)) {
              throw new Error(
                `Output "${match}" contains placeholder content. Task "${taskId}" cannot be marked done until the file is fully implemented.`
              )
            }
          }
        }
      }

      // (Output schema lint was a DQA-SDLC concern — removed from the generic
      // kernel. Output validation here is: file exists + non-stub, plus the
      // optional per-task `validate:` expression below.)
    }

    // Validate expression (for any task type with validate field)
    const rawValidateExpr = task.validate as string | undefined
    if (rawValidateExpr) {
      // Auto-enrich the expression context from the task's primary output file.
      // This allows validate expressions like `task_id.field == value` to
      // evaluate against YAML/frontmatter content the agent wrote, without
      // requiring agents to pass --exports explicitly.
      let validateCtx = mergedExprCtx
      const rawOutput = task.output as string | string[] | undefined
      const primaryOutput = Array.isArray(rawOutput) ? rawOutput[0] : rawOutput
      if (primaryOutput && !primaryOutput.includes('*') && !primaryOutput.includes('{')) {
        const resolvedPrimary = this.resolveVars(primaryOutput, vars)
        const absOutput = path.isAbsolute(resolvedPrimary)
          ? resolvedPrimary
          : path.join(this.projectDir, resolvedPrimary)
        const fileExports = await parseOutputExports(absOutput)
        if (fileExports) {
          validateCtx = this.makeExprContext(
            { ...state.exports, ...fileExports },
            opts?.exports,
          )
        }
      }

      const { value: valid, resolved } = await this.evaluateResolved(rawValidateExpr, validateCtx)
      if (!valid) {
        // Diagnose the common trap: the expression references a `task.metric`
        // export the output file never declared. Such a dotted identifier
        // silently resolves to its own name (the unresolvable sentinel), so
        // `wireframes.tbd_count == 0` is false and the raw expression reads
        // like a restatement of the rule rather than a "metric not found"
        // error. Only dotted identifiers are inspected — bare words and
        // `func(...)`-style validates (e.g. file-content(...) includes "x")
        // are left alone to avoid false positives.
        const dotted = [...new Set(resolved.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g) ?? [])]
        const missing = dotted.filter(id => !id.startsWith('runs.') && !isDefinedIdentifier(id, validateCtx))
        let hint = ''
        if (missing.length > 0) {
          const primaryOut = Array.isArray(task.output) ? task.output[0] : task.output
          const [root, ...rest] = missing[0].split('.')
          const leaf = rest.join('.') || 'value'
          hint =
            ` — ${missing.map(i => `\`${i}\``).join(', ')} ` +
            `${missing.length > 1 ? 'were' : 'was'} never declared, so the rule cannot pass. ` +
            `Declare ${missing.length > 1 ? 'them' : 'it'} in the YAML frontmatter of the output file` +
            `${primaryOut ? ` (${primaryOut})` : ''}:\n---\n${root}:\n  ${leaf}: <value>\n---\n` +
            `or pass via \`dqa done ${taskId} --exports '{"${missing[0]}": <value>}'\`. ` +
            `This is NOT about placeholder text inside the prose.`
        }
        throw new Error(`Validation failed for task "${taskId}": ${resolved}${hint}`)
      }
    }

    // Write done event — store resolved output path in state
    const rawDoneOutput = task.output as string | string[] | undefined
    const doneOutputStr = rawDoneOutput === undefined
      ? ''
      : Array.isArray(rawDoneOutput)
        ? rawDoneOutput.map(o => this.resolveVars(o, vars)).join(',')
        : this.resolveVars(rawDoneOutput, vars)
    const resolvedOutput = doneOutputStr

    // Structured outputs: if the step declares typed outputs, capture + validate
    // them before recording done. Values come from the output file's YAML
    // frontmatter and/or --exports (explicit --exports wins). Stored per-step so
    // downstream `when:` / `validate:` can branch on `<step-id>.<field>`.
    let capturedOutputs: Record<string, unknown> | undefined
    const outputsDecl = (task as { outputs?: OutputsDecl }).outputs
    if (outputsDecl && Object.keys(outputsDecl).length > 0) {
      const provided: Record<string, unknown> = { ...(opts?.exports ?? {}) }
      const rawOut = task.output as string | string[] | undefined
      const primary = Array.isArray(rawOut) ? rawOut[0] : rawOut
      if (primary && !primary.includes('*') && !primary.includes('{')) {
        const resolvedPrimary = this.resolveVars(primary, vars)
        const absOut = path.isAbsolute(resolvedPrimary) ? resolvedPrimary : path.join(this.projectDir, resolvedPrimary)
        const fm = await parseOutputExports(absOut)
        if (fm) for (const [k, v] of Object.entries(fm)) if (!(k in provided)) provided[k] = v
      }
      const res = validateOutputs(outputsDecl, provided, taskId)
      if (!res.ok) throw new Error(formatOutputErrors(taskId, res.errors))
      capturedOutputs = res.values
    }

    await writeTaskDone(this.stateDir, currentPhaseId ?? '_unknown', taskId, {
      output: resolvedOutput,
      by: opts?.by,
      exports: opts?.exports,
      outputs: capturedOutputs,
    })

    // Compound-parent completion is reconciled inside nextInternal (below),
    // derived from state — no per-event rollup needed here.
    return this.nextInternal(opts?.parallel ?? 1)
  }

  // ── fail ───────────────────────────────────────────────────────────────

  /**
   * Record that a step's executor threw, then carry on with whatever else can run.
   *
   * WHY THIS EXISTS. Before it, a throwing executor propagated straight out of the drive loop and the entire
   * run died — including steps that declare `depends: []` and had nothing to do with the failure. Measured
   * cost of that (a real deployment, 04/08/2026): one client spreadsheet that could not be parsed took down the
   * whole ingest, and **22 healthy files were never read**. The failure was real; killing 22 unrelated files
   * was not.
   *
   * What it does NOT do: let downstream proceed. `failed` does not satisfy a dependency, so the failed step's
   * subtree stays blocked. That containment is the DAG's job and it is why this is safe — a step can only run
   * when everything it declared it needs actually produced output.
   */
  async fail(taskId: string, error: string): Promise<NextResult> {
    const state = await loadState(this.stateDir)
    const phaseId = (await this.findCurrentPhase(state, this.workflow.pipeline)) ?? 'unknown'
    await writeTaskFailed(this.stateDir, phaseId, taskId, error)
    return this.next()
  }

  // ── approve ────────────────────────────────────────────────────────────

  async approve(gateId: string, optsOrBy?: ApproveOptions | string): Promise<NextResult> {
    const opts: ApproveOptions = typeof optsOrBy === 'string'
      ? { by: optsOrBy }
      : (optsOrBy ?? {})

    const state = await loadState(this.stateDir)
    const currentPhaseId = await this.findCurrentPhase(state, this.workflow.pipeline)

    // Write gate approval
    await writeGateApproved(this.stateDir, currentPhaseId ?? '_unknown', gateId, opts.by)

    return this.nextInternal(opts.parallel ?? 1)
  }

  // ── For-each expansion ─────────────────────────────────────────────────

  /**
   * Expand compound tasks (for-each, parallel, switch) into concrete sub-tasks.
   * Simple tasks (agent-task, gate, action) pass through unchanged.
   */
  private async expandTasks(tasks: AnyTask[], state: WorkflowState): Promise<ExpandedTask[]> {
    const result: ExpandedTask[] = []

    for (const task of tasks) {
      if (task.type === 'for-each') {
        const expanded = await this.expandForEach(task, state)
        result.push(...expanded)
      } else if (task.type === 'parallel') {
        const expanded = await this.expandParallel(task, state)
        result.push(...expanded)
      } else if (task.type === 'switch') {
        const expanded = await this.expandSwitch(task, state)
        result.push(...expanded)
      } else {
        result.push(task as ExpandedTask)
      }
    }

    return result
  }

  private async expandForEach(
    task: AnyTask,
    state: WorkflowState,
    bind?: { idPrefix: string; extraVars: Record<string, string> },
  ): Promise<ExpandedTask[]> {
    const source = task.source as string
    const varName = task.as as string
    const subTasks = (task['sub-tasks'] as AnyTask[]) ?? []
    // Effective id carries the enclosing-loop prefix when this for-each is
    // itself a sub-task of an outer for-each (nested). Top-level: idPrefix=''.
    const idPrefix = bind?.idPrefix ?? ''
    const parentId = `${idPrefix}${task.id}`
    const extraVars = bind?.extraVars ?? {}
    const deps = task.depends ?? []

    // Check parent deps first — if unmet, return the parent as a blocked
    // placeholder. Nested loops emit no placeholder: their enclosing marker
    // node already stands in for this loop in the expanded list.
    const unmetDeps = deps.filter(d =>
      !satisfiesDep(state.tasks[d]?.status)
    )
    if (unmetDeps.length > 0) {
      return bind ? [] : [{ ...task, _forEachParent: undefined } as ExpandedTask]
    }

    // Resolve the source pattern against state exports so variables like
    // {change-id} in "changes/{change-id}/stories/story-*.md" are substituted
    // before globbing. extraVars carries the enclosing loop's item vars (e.g.
    // {feature.id}) so a nested source like "spec/stories/{feature.id}/*.md"
    // resolves against the current outer item.
    const stateVars = this.exportVarsAsStrings(this.makeExprContext(state.exports).exports ?? {})
    const globalVars = { workspace: this.frameworkRoot, 'project-dir': this.projectDir, ...stateVars, ...extraVars }
    const resolvedSource = this.resolveVars(source, globalVars)

    // Glob the resolved source pattern to find items (sorted for deterministic
    // order). nocase: a for-each over e.g. STORY-*.md must still match files
    // written as story-*.md — case drift in artefact names is non-fatal.
    const matches = (await glob(resolvedSource, { cwd: this.projectDir, nodir: true, nocase: true })).sort()

    if (matches.length === 0) {
      // No matches — at top level return the parent as an un-done placeholder
      // so a LATER next() can re-expand once the source files appear (the
      // producing step may emit them between calls). Do NOT persist a skip:
      // that would permanently kill re-evaluation. Nested: return nothing —
      // the enclosing marker remains incomplete, surfacing as `blocked`.
      if (bind) return []
      if (!state.tasks[parentId]?.status) {
        return [{ ...task } as ExpandedTask]
      }
      return []
    }

    const expanded: ExpandedTask[] = []

    for (const match of matches) {
      // Extract item identity from the matched file
      const itemId = this.extractItemId(match)
      const numericSuffix = itemId.match(/(\d+)$/)?.[1] ?? itemId
      // Merge enclosing-loop vars first so an inner sub-task can reference both
      // {feature.id} (outer) and {story.id} (this loop).
      const itemVars: Record<string, string> = {
        ...extraVars,
        [`${varName}.id`]: itemId,
        [`${varName}.path`]: match,
        // Directory the matched item lives in (POSIX-style, relative to the
        // project dir). Lets a sub-task write output back beside its source —
        // e.g. output: '{story.dir}/{story.id}.md' for stories foldered by
        // bounded context (spec/stories/<context>/STORY-NNN.*). For a flat
        // source this is just the parent dir, so it degrades to the old layout.
        [`${varName}.dir`]: path.dirname(match),
        [`${varName}.title`]: itemId.replace(/-/g, ' '),
        [`${varName}.n`]: numericSuffix,
      }
      const itemBase = `${parentId}:${itemId}`

      for (const sub of subTasks) {
        const expandedId = `${itemBase}:${sub.id}`
        const subType = (sub.type as string) ?? 'agent-task'

        // Resolve depends — prefix sibling references (within this loop's
        // sub-tasks) with this item's base id; resolve any vars in the rest.
        const subDeps = (sub.depends ?? []).map((d: string) => {
          if (subTasks.some(s => s.id === d)) return `${itemBase}:${d}`
          return this.resolveVars(d, itemVars)
        })

        // ── Nested for-each ────────────────────────────────────────────────
        // Emit a marker node (so a per-item sibling can `depends:` on this
        // inner loop and the completion rollup knows its parent is THIS item's
        // loop), then recurse to expand the inner loop's descendants.
        if (subType === 'for-each') {
          expanded.push({
            ...sub,
            id: expandedId,
            depends: subDeps,
            type: 'for-each',
            _forEachParent: parentId,
            _forEachItem: match,
          } as ExpandedTask)

          if (state.tasks[expandedId]?.status === 'done' || state.tasks[expandedId]?.status === 'skipped') {
            continue
          }

          const innerExpanded = await this.expandForEach(
            { ...sub, depends: subDeps } as AnyTask,
            state,
            { idPrefix: `${itemBase}:`, extraVars: itemVars },
          )
          expanded.push(...innerExpanded)
          continue
        }

        // Skip if already done — still include so completion checks see it.
        if (state.tasks[expandedId]?.status === 'done' || state.tasks[expandedId]?.status === 'skipped') {
          expanded.push({
            ...sub,
            id: expandedId,
            type: subType,
            depends: subDeps,
            _forEachParent: parentId,
            _forEachItem: match,
          } as ExpandedTask)
          continue
        }

        // Resolve variable references in fields using item-level vars
        const rawSubOutput = sub.output as string | string[] | undefined
        const resolvedOutput = rawSubOutput === undefined
          ? ''
          : Array.isArray(rawSubOutput)
            ? rawSubOutput.map(o => this.resolveVars(o, itemVars))
            : this.resolveVars(rawSubOutput, itemVars)
        const resolvedInstruction = this.resolveVars((sub.instruction as string) ?? '', itemVars)

        // Resolve additional fields so sub-tasks can use {story.id} etc. in
        // their run/when/validate/description fields.  State-level vars (e.g.
        // {change-id}) are resolved later in findReadyTask / evaluateResolved.
        const resolvedRun = sub.run
          ? this.resolveVars(sub.run as string, itemVars) : undefined
        const resolvedWhen = sub.when
          ? this.resolveVars(sub.when as string, itemVars) : undefined
        const resolvedValidate = sub.validate
          ? this.resolveVars(sub.validate as string, itemVars) : undefined
        const resolvedDescription = sub.description
          ? this.resolveVars(sub.description as string, itemVars) : undefined

        expanded.push({
          ...sub,
          id: expandedId,
          output: resolvedOutput,
          instruction: resolvedInstruction,
          ...(resolvedRun !== undefined ? { run: resolvedRun } : {}),
          ...(resolvedWhen !== undefined ? { when: resolvedWhen } : {}),
          ...(resolvedValidate !== undefined ? { validate: resolvedValidate } : {}),
          ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {}),
          depends: subDeps,
          type: subType,
          _forEachParent: parentId,
          _forEachItem: match,
          _itemVars: itemVars,
        } as ExpandedTask)
      }
    }

    return expanded
  }

  /**
   * Expand a parallel task: flatten nested tasks with the parent's deps.
   * All sub-tasks run with no ordering constraint between them.
   */
  private async expandParallel(task: AnyTask, state: WorkflowState): Promise<ExpandedTask[]> {
    const parentId = task.id
    const parentDeps = task.depends ?? []
    const subTasks = (task.tasks as AnyTask[]) ?? []

    // Check parent deps — if unmet, return parent as placeholder
    const unmetDeps = parentDeps.filter(d =>
      !satisfiesDep(state.tasks[d]?.status)
    )
    if (unmetDeps.length > 0) {
      return [{ ...task } as ExpandedTask]
    }

    const expanded: ExpandedTask[] = []
    for (const sub of subTasks) {
      const expandedId = `${parentId}:${sub.id}`

      // Sub-tasks inherit parent deps (they all start when parent deps met)
      // Plus any sub-task-specific deps (prefixed with parent:)
      const subDeps = (sub.depends ?? []).map((d: string) =>
        subTasks.some(s => s.id === d) ? `${parentId}:${d}` : d
      )

      expanded.push({
        ...sub,
        id: expandedId,
        depends: [...parentDeps, ...subDeps],
        type: (sub.type as string) ?? 'agent-task',
        _forEachParent: parentId,
      } as ExpandedTask)
    }

    // Check if all expanded sub-tasks are done → auto-complete parent
    const allDone = expanded.every(t =>
      state.tasks[t.id]?.status === 'done' || state.tasks[t.id]?.status === 'skipped'
    )
    if (allDone && expanded.length > 0 && !state.tasks[parentId]?.status) {
      // Will be auto-completed via checkForEachCompletion (same mechanism)
    }

    return expanded
  }

  /**
   * Expand a switch task: evaluate the expression, pick the matching route,
   * and return those tasks. Only one branch runs.
   */
  private async expandSwitch(task: AnyTask, state: WorkflowState): Promise<ExpandedTask[]> {
    const parentId = task.id
    const parentDeps = task.depends ?? []
    const evalExpr = task.eval as string
    const routes = task.routes as Record<string, AnyTask[]> | undefined
    const defaultTasks = (task.default as AnyTask[]) ?? []

    // Check parent deps — if unmet, return parent as placeholder
    const unmetDeps = parentDeps.filter(d =>
      !satisfiesDep(state.tasks[d]?.status)
    )
    if (unmetDeps.length > 0) {
      return [{ ...task } as ExpandedTask]
    }

    // If parent already done (branch was chosen and completed), skip
    if (state.tasks[parentId]?.status === 'done') {
      return []
    }

    // Evaluate the switch expression
    const exprCtx = this.makeExprContext(state.exports)
    const { value } = await this.evaluateResolved(evalExpr, exprCtx)
    const valueStr = String(value)

    // Find matching route
    const branchTasks = routes?.[valueStr] ?? defaultTasks

    const expanded: ExpandedTask[] = []
    for (const sub of branchTasks) {
      const expandedId = `${parentId}:${sub.id}`
      const subDeps = (sub.depends ?? []).map((d: string) =>
        branchTasks.some(s => s.id === d) ? `${parentId}:${d}` : d
      )

      expanded.push({
        ...sub,
        id: expandedId,
        depends: [...parentDeps, ...subDeps],
        type: (sub.type as string) ?? 'agent-task',
        _forEachParent: parentId,
      } as ExpandedTask)
    }

    return expanded
  }

  /** Extract an item ID from a file path: stories/story-001.md → story-001 */
  private extractItemId(filePath: string): string {
    const base = path.basename(filePath, path.extname(filePath))
    return base
  }

  /** Replace {var.key} placeholders in a string */
  private resolveVars(template: string, vars: Record<string, string>): string {
    return template.replace(/\{([^}]+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`)
  }

  /**
   * Resolve {var} placeholders against the expression context, then
   * evaluate. Every expression site in a workflow YAML (prereq, validate,
   * check, when, switch eval) must go through this so placeholders are
   * interpolated before the expression engine sees them.
   */
  private async evaluateResolved(
    expr: string,
    ctx: ExpressionContext,
  ): Promise<{ value: unknown; resolved: string }> {
    const vars = this.exportVarsAsStrings(ctx.exports ?? {})
    const actionVars = { ...vars, 'project-dir': this.projectDir }
    const resolved = this.resolveVars(expr, actionVars)
    const value = await evaluateExpression(resolved, ctx)
    return { value, resolved }
  }

  /** Convert exports (Record<string, unknown>) to string vars for resolveVars */
  private exportVarsAsStrings(exports: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(exports).map(([k, v]) => [k, String(v)])
    )
  }

  /**
   * Mark every compound parent done once all its children are complete.
   *
   * Covers nested for-each markers (e.g. `implement:auth:stories`) AND the
   * top-level compound task (`implement`). Completion is derived purely from
   * current state, so it is event-independent: a trailing GATE child closed via
   * approve() — which never ran a done()-side rollup — still completes its
   * parent. A fixpoint loop lets deep nesting cascade in one call (inner marker
   * → outer parent) since marking an inner marker done makes the outer parent's
   * children all-complete on the next turn. A gate child counts complete when
   * its gate is `passed` (its task record is closed lazily in findReadyTask).
   * Persists each parent-done event and reflects it on the in-memory snapshot
   * so the caller's phaseDone check sees it within the same next().
   */
  private async reconcileCompletions(
    expanded: ExpandedTask[],
    phaseId: string,
    state: WorkflowState,
  ): Promise<void> {
    const childrenByParent = new Map<string, ExpandedTask[]>()
    for (const t of expanded) {
      const p = (t as ExpandedTask)._forEachParent
      if (!p) continue
      const arr = childrenByParent.get(p)
      if (arr) arr.push(t)
      else childrenByParent.set(p, [t])
    }
    if (childrenByParent.size === 0) return

    const isComplete = (id: string): boolean =>
      state.tasks[id]?.status === 'done' ||
      state.tasks[id]?.status === 'skipped' ||
      state.gates[id]?.status === 'passed'

    let changed = true
    while (changed) {
      changed = false
      for (const [parentId, children] of childrenByParent) {
        if (state.tasks[parentId]?.status) continue
        if (!children.every(c => isComplete(c.id))) continue
        await writeTaskDone(this.stateDir, phaseId, parentId, {
          output: '',
          exports: { [`${parentId}.count`]: children.length },
        })
        state.tasks[parentId] = { task: parentId, status: 'done', at: new Date().toISOString(), output: '' }
        changed = true
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async findCurrentPhase(state: WorkflowState, pipeline: PipelineEntry[]): Promise<string | null> {
    const exprCtx = this.makeExprContext(state.exports)

    // Walk pipeline to find first incomplete phase
    for (const entry of pipeline) {
      // Phase-level skip (already recorded)
      if (state.skippedPhases.has(entry.phase)) continue

      // Evaluate when condition — skip and record if false
      if (entry.when) {
        const { value: condResult, resolved } = await this.evaluateResolved(entry.when, exprCtx)
        if (!condResult) {
          await writePhaseSkipped(this.stateDir, entry.phase, `when: ${resolved}`)
          state.skippedPhases.add(entry.phase)
          continue
        }
      }

      const phaseBody = this.workflow.phases[entry.phase]
      if (!phaseBody) continue

      // Check if all tasks in this phase are done or skipped
      // For for-each tasks, check the parent task ID (auto-completed when children done)
      const allDone = (phaseBody.tasks as AnyTask[]).every(t =>
        state.tasks[t.id]?.status === 'done' || state.tasks[t.id]?.status === 'skipped'
      )

      if (!allDone) {
        return entry.phase
      }
    }

    return null // all phases complete
  }

  private async findReadyTask(
    tasks: ExpandedTask[],
    phaseId: string,
    state: WorkflowState,
    maxAgentBatch = 1,
  ): Promise<NextResult | null> {
    const exprCtx = this.makeExprContext(state.exports)
    const vars = { workspace: this.frameworkRoot, 'project-dir': this.projectDir, ...this.exportVarsAsStrings(exprCtx.exports ?? {}) }

    // Phase 1: scan tasks sequentially, applying state side-effects (skip
    // writes, auto-done for approved gates), and collect ready agent-tasks
    // to be resolved in parallel below. A gate or action encountered
    // mid-scan terminates collection — it's handled as a single-step
    // response, optionally after returning whatever batch was already
    // assembled.
    interface PendingAgent {
      task: ExpandedTask
      deps: string[]
      resolvedOutput: string
    }
    const pending: PendingAgent[] = []
    let shortCircuit: NextResult | null = null
    // Tracks whether scanning hit an unmet-dep gap since the last batched
    // task. If pending is empty we keep looking past the gap (the next
    // ready task starts a fresh batch). If pending already has tasks we
    // stop — extending across a gap would batch non-consecutive items.
    let gapSinceLastBatched = false

    for (const task of tasks) {
      const taskId = task.id

      // SETTLED = done · skipped · failed. `failed` belongs here even though it is not a success: leaving it
      // out means every next() re-dispatches the same step, and a deterministic failure (a file that will
      // never parse) becomes an infinite retry loop that looks like a hang.
      if (isSettled(state.tasks[taskId]?.status)) {
        continue
      }

      if (task.type === 'for-each' || task.type === 'parallel' || task.type === 'switch') {
        continue
      }

      if (task.type === 'gate') {
        const deps = task.depends ?? []
        // A 'skipped' dep is satisfied — same rule as agent-tasks below.
        // Treating 'skipped' as unmet would strand a gate behind a task
        // that the workflow correctly chose not to run (e.g. its `when`
        // evaluated false), making the entire phase look stuck.
        const unmetDeps = deps.filter(d =>
          !satisfiesDep(state.tasks[d]?.status)
        )
        if (unmetDeps.length > 0) {
          if (pending.length > 0) break
          gapSinceLastBatched = true
          continue
        }

        // Gates can carry a `when:` expression too. If it evaluates false
        // the gate is irrelevant for this run — auto-skip so the phase
        // doesn't deadlock waiting for an approval that doesn't apply.
        if (task.when) {
          const { value: condResult, resolved } = await this.evaluateResolved(
            task.when as string,
            exprCtx,
          )
          if (!condResult) {
            await writeTaskSkipped(this.stateDir, phaseId, taskId, `when: ${resolved}`)
            state.tasks[taskId] = { task: taskId, status: 'skipped', at: new Date().toISOString(), reason: `when: ${resolved}` }
            continue
          }
        }

        if (state.gates[taskId]?.status === 'passed') {
          await writeTaskDone(this.stateDir, phaseId, taskId, { output: '' })
          // Reflect the auto-done on the in-memory snapshot so the phaseDone
          // check below (which operates on this snapshot, not reloaded state)
          // can see that every task — including this just-closed gate — is
          // complete, and the workflow can advance.
          state.tasks[taskId] = { task: taskId, status: 'done', at: new Date().toISOString(), output: '' }
          continue
        }

        // Gate is a barrier. Return whatever batch is already pending;
        // the gate will be re-surfaced on the next invocation.
        if (pending.length > 0) break

        shortCircuit = {
          status: 'waiting',
          gate: taskId,
          type: 'approval',
          description: (task.description as string) ?? '',
        }
        break
      }

      if (task.when) {
        const { value: condResult, resolved } = await this.evaluateResolved(
          task.when as string,
          exprCtx,
        )
        if (!condResult) {
          await writeTaskSkipped(this.stateDir, phaseId, taskId, `when: ${resolved}`)
          // Reflect the skip on the in-memory snapshot too — the phaseDone check
          // in nextInternal reads this snapshot, not reloaded state. Without it a
          // when:false task stays 'pending' there, so a workflow whose remaining
          // work was all conditionally skipped reports a false `blocked` instead
          // of `complete` (the gate branch above already does this).
          state.tasks[taskId] = { task: taskId, status: 'skipped', at: new Date().toISOString(), reason: `when: ${resolved}` }
          continue
        }
      }

      const deps = task.depends ?? []
      const unmetDeps = deps.filter(d =>
        !satisfiesDep(state.tasks[d]?.status)
      )
      if (unmetDeps.length > 0) {
        if (pending.length > 0) break
        gapSinceLastBatched = true
        continue
      }

      if (task.type === 'action') {
        if (pending.length > 0) break

        const actionVars = { ...vars, project: this.project, 'project-dir': this.projectDir }
        const resolvedRun = this.resolveVars(task.run as string, actionVars)
        shortCircuit = {
          status: 'next' as const,
          task: taskId,
          phase: phaseId,
          type: 'action',
          instruction: `Run: ${resolvedRun}`,
          output: '',
          depends: deps.map((d: string) => ({
            id: d,
            status: state.tasks[d]?.status ?? 'unknown',
            path: state.tasks[d]?.output,
          })),
          context: { files: [] },
          project_base_dir: this.projectDir,
        }
        break
      }

      // Agent-task — defer instruction fetch to the parallel phase below.
      const rawNextOutput = task.output as string | string[] | undefined
      const resolvedOutput = rawNextOutput === undefined
        ? ''
        : Array.isArray(rawNextOutput)
          ? rawNextOutput.map(o => this.resolveVars(o, vars)).join(',')
          : this.resolveVars(rawNextOutput, vars)

      // Adjacency-based parallelism: a batch grows only by absorbing the
      // next task in declaration order. The first task in a batch can be
      // anything (parallel-safe or not), but if it isn't parallel-safe
      // the batch is locked to size 1. Subsequent tasks join only when
      // they are parallel-safe AND there has been no gap (unmet-dep task
      // skipped) since the last batched task — a gap means YAML order
      // intended a non-batched task to sit between them.
      const isParallelSafe = task['parallel-safe'] === true
      if (pending.length === 0) {
        pending.push({ task, deps, resolvedOutput })
        gapSinceLastBatched = false
        if (!isParallelSafe) break
      } else {
        if (gapSinceLastBatched) break
        if (!isParallelSafe) break
        pending.push({ task, deps, resolvedOutput })
      }
      if (pending.length >= maxAgentBatch) break
    }

    if (shortCircuit) return shortCircuit
    if (pending.length === 0) return null

    // Phase 2: resolve instructions for all pending agent-tasks in parallel.
    // With remote content mode on, each resolve is an HTTP round-trip to
    // /v1/render-task; Promise.all turns N × RTT into ~1 × RTT.
    // Executor-driven steps (`uses:`) are run by the engine, not an agent, so
    // they never need a (possibly remote) task-instruction resolution.
    const rawInstructions = await Promise.all(
      pending.map(p => p.task.uses
        ? Promise.resolve(p.task.instruction as string | undefined)
        : this.resolveInstruction(p.task.id, p.task.instruction as string | undefined))
    )

    // Phase 3: build payloads.
    const agentBatch: NextTaskPayload[] = pending.map((p, i) => {
      const rawInstruction = rawInstructions[i]
      // Merge for-each item vars (e.g. story.id, story.path) so that
      // file-based task instructions can use {story.id} placeholders.
      const itemVars = (p.task._itemVars as Record<string, string>) ?? {}
      const allVars = { ...vars, ...itemVars }
      const instruction = rawInstruction ? this.resolveVars(rawInstruction, allVars) : undefined
      return {
        task: p.task.id,
        phase: phaseId,
        type: (p.task.type as string) ?? 'agent-task',
        instruction,
        guidance: p.task.guidance as string | undefined,
        guardrails: p.task.guardrails as string[] | undefined,
        output: p.resolvedOutput,
        depends: p.deps.map((d: string) => ({
          id: d,
          status: state.tasks[d]?.status ?? 'unknown',
          path: state.tasks[d]?.output,
        })),
        context: {
          files: p.deps
            .map((d: string) => state.tasks[d]?.output)
            .filter((x): x is string => !!x),
        },
        ...(p.task.model ? { model: p.task.model as 'sonnet' | 'opus' | 'haiku' } : {}),
        ...(p.task.outputs ? { outputs: p.task.outputs as OutputsDecl } : {}),
        ...(p.task.uses ? { uses: p.task.uses as string } : {}),
        ...(p.task.with ? { with: p.task.with as Record<string, unknown> } : {}),
        project_base_dir: this.projectDir,
      }
    })

    if (maxAgentBatch <= 1) {
      return { status: 'next' as const, ...agentBatch[0] }
    }
    return {
      status: 'next-batch' as const,
      phase: phaseId,
      tasks: agentBatch,
    }
  }

  private async advanceToNextPhase(
    state: WorkflowState,
    pipeline: PipelineEntry[],
    currentPhaseId: string,
    maxAgentBatch = 1,
  ): Promise<NextResult> {
    const currentIdx = pipeline.findIndex(p => p.phase === currentPhaseId)
    const exprCtx = this.makeExprContext(state.exports)

    for (let i = currentIdx + 1; i < pipeline.length; i++) {
      const entry = pipeline[i]

      // Check phase when condition
      if (entry.when) {
        const { value: condResult, resolved } = await this.evaluateResolved(entry.when, exprCtx)
        if (!condResult) {
          await writePhaseSkipped(this.stateDir, entry.phase, `when: ${resolved}`)
          continue
        }
      }

      // Found next active phase — recurse to find ready task(s), preserving
      // the caller's batch size so the chained advancement still returns
      // a parallel batch when one was requested.
      return this.nextInternal(maxAgentBatch)
    }

    // No more phases
    return this.completeWorkflow(state)
  }

  private completeWorkflow(state: WorkflowState): NextResult {
    const tasksDone = Object.values(state.tasks).filter(t => t.status === 'done').length
    const tasksSkipped = Object.values(state.tasks).filter(t => t.status === 'skipped').length
    const failed = Object.values(state.tasks).filter(t => t.status === 'failed')

    return {
      status: 'complete',
      summary: {
        phases: this.workflow.pipeline.length,
        tasksDone,
        tasksSkipped,
        // NÊU TÊN. A run that reaches the end with failed steps is NOT a clean run, and reporting only
        // `complete` would let the caller record success over a hole in the data. The caller decides what
        // to do; the engine's duty is to make the hole impossible to miss.
        ...(failed.length ? { tasksFailed: failed.map(t => ({ task: t.task, error: t.error ?? '' })) } : {}),
      },
    }
  }

  private findTaskInWorkflow(taskId: string): AnyTask | undefined {
    for (const phase of Object.values(this.workflow.phases)) {
      const found = (phase.tasks as AnyTask[]).find(t => t.id === taskId)
      if (found) return found
    }
    return undefined
  }

  /**
   * Check composite-mandated cross-run prereqs from this run's _run.yaml.
   * Returns a blocked NextResult when any prereq gate is not yet approved
   * in the referenced sibling run; returns null when all prereqs are met
   * (or no prereqs are declared).
   *
   * Pull mode: each `dqa next` call re-reads sibling state so the run
   * advances as soon as upstream approvals land — no daemon needed.
   */
  private async checkCompositePrereqs(state: WorkflowState): Promise<NextResult | null> {
    const prereqs = state.run.compositePrereqs ?? []
    if (prereqs.length === 0) return null

    const siblings = await this.loadSiblingRunSnapshots(prereqs.map(p => p.run))
    const unmet: string[] = []
    for (const prereq of prereqs) {
      const fullRunId = `${this.project}--${prereq.run}`
      const snap = siblings[fullRunId]
      if (!snap || snap.gates[prereq.gate]?.status !== 'passed') {
        unmet.push(`${prereq.run}:${prereq.gate}`)
      }
    }

    if (unmet.length === 0) return null

    return {
      status: 'blocked',
      gate: '_composite-prereq',
      check: `composite prereqs unmet: ${unmet.join(', ')}`,
      currentValue: 'pending',
      suggestion:
        `Wait for upstream runs to approve their hand-off gates: ${unmet.join(', ')}. ` +
        `Run \`dqa status --project ${this.project} --run <upstream-run-id>\` to inspect.`,
    }
  }

  /**
   * Load sibling run snapshots for cross-run state evaluation. Reads
   * `.dqa/state/<project>--<runId>/_run.yaml` plus all gate.approved.*
   * events in that directory. Returns a record keyed by full run id
   * (e.g. `acme--ba`) so it slots directly into ExpressionContext.runs.
   *
   * Errors loading any individual sibling are swallowed — a missing or
   * not-yet-started run is represented as { gates: {}, exports: {} }.
   */
  private async loadSiblingRunSnapshots(
    siblingRunIds: string[],
  ): Promise<Record<string, RunSnapshot>> {
    const result: Record<string, RunSnapshot> = {}
    for (const runId of siblingRunIds) {
      const fullRunId = `${this.project}--${runId}`
      const siblingStateDir = getStateDir(this.frameworkRoot, this.project, runId)
      try {
        const siblingState = await loadState(siblingStateDir)
        result[fullRunId] = {
          gates: siblingState.gates as Record<string, { status: string; at: string; by?: string }>,
          exports: siblingState.exports,
        }
      } catch {
        // Sibling run not yet started — present as empty snapshot.
        result[fullRunId] = { gates: {}, exports: {} }
      }
    }
    return result
  }

  private async resolveInstruction(taskId: string, inline?: string): Promise<string | undefined> {
    const { resolveTaskInstruction } = await import('./resolve-task-instruction.js')
    // Read `task-instructions-from` from workflow YAML — string or array.
    // Empty/undefined means no fallback (legacy single-namespace behavior).
    const tif = (this.workflow as WorkflowV3 & { 'task-instructions-from'?: string | string[] })['task-instructions-from']
    const fallbackChain = tif === undefined
      ? undefined
      : Array.isArray(tif) ? tif : [tif]
    return resolveTaskInstruction(
      this.frameworkRoot,
      this.workflow.name,
      taskId,
      inline,
      fallbackChain,
    )
  }

  private resolveResultPaths(result: NextResult): NextResult {
    if (result.status !== 'next' && result.status !== 'next-batch') return result
    const resolve = (p: string) =>
      p && !path.isAbsolute(p) ? path.join(this.projectDir, p) : p
    const resolvePayload = (t: NextTaskPayload): NextTaskPayload => ({
      ...t,
      output: resolve(t.output),
      context: { files: t.context.files.map(resolve) },
      depends: t.depends.map(d => ({ ...d, path: d.path ? resolve(d.path) : d.path })),
    })
    if (result.status === 'next') return { ...result, ...resolvePayload(result) }
    return { ...result, tasks: result.tasks.map(resolvePayload) }
  }

  private makeExprContext(
    exports: Record<string, unknown>,
    additionalExports?: Record<string, unknown>,
  ): ExpressionContext {
    return {
      exports: { ...exports, ...(additionalExports ?? {}) },
      baseDir: this.projectDir,
    }
  }
}
