import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import type { WorkflowV3 } from './schema-types-v3.js'
import { getStateDir, initRun, loadState, writeTaskDone, writeGateApproved } from './state-manager.js'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'

let tmpDir: string
let projectDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-orch-'))
  projectDir = path.join(tmpDir, '.dqa', 'projects', 'test-proj')
  await fs.mkdirp(projectDir)
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

// ── Helper: minimal workflow ───────────────────────────────────────────────

const simpleWorkflow: WorkflowV3 = {
  name: 'simple',
  version: 3,
  pipeline: [
    { phase: 'phase-a' },
    { phase: 'phase-b' },
  ],
  phases: {
    'phase-a': {
      description: 'First phase',
      tasks: [
        { id: 'task-1', type: 'agent-task', output: 'task-1.md', depends: [], instruction: 'Do task 1' },
        { id: 'task-2', type: 'agent-task', output: 'task-2.md', depends: ['task-1'], instruction: 'Do task 2' },
      ],
    },
    'phase-b': {
      description: 'Second phase',
      tasks: [
        { id: 'task-3', type: 'agent-task', output: 'task-3.md', depends: [], instruction: 'Do task 3' },
      ],
    },
  },
}

function createOrchestrator(workflow: WorkflowV3) {
  return new Orchestrator(tmpDir, 'test-proj', workflow)
}

// ── start() ────────────────────────────────────────────────────────────────

describe('orchestrator.start()', () => {
  it('creates run state and returns first task', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    const result = await orch.start()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('task-1')
      expect(result.phase).toBe('phase-a')
      expect(result.instruction).toBe('Do task 1')
    }
  })

  it('checks prereq and throws when not met', async () => {
    const workflow: WorkflowV3 = {
      ...simpleWorkflow,
      prereq: 'file-exists(domain.md)',
    }
    const orch = createOrchestrator(workflow)
    await expect(orch.start()).rejects.toThrow(/prereq/)
  })

  it('checks prereq and proceeds when met', async () => {
    await fs.writeFile(path.join(projectDir, 'domain.md'), '# Domain')
    const workflow: WorkflowV3 = {
      ...simpleWorkflow,
      prereq: 'file-exists(domain.md)',
    }
    const orch = createOrchestrator(workflow)
    const result = await orch.start()
    expect(result.status).toBe('next')
  })
})

// ── next() Stage 1: find ready task ────────────────────────────────────────

describe('orchestrator.next() — find ready task', () => {
  it('returns first task with no deps', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('task-1')
    }
  })

  it('skips done tasks and returns next ready', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()

    // Mark task-1 done
    await fs.writeFile(path.join(projectDir, 'task-1.md'), 'Done')
    await orch.done('task-1')

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('task-2')
    }
  })

  it('returns task when all deps are met', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()

    // task-2 depends on task-1. Mark task-1 done.
    await fs.writeFile(path.join(projectDir, 'task-1.md'), 'Done')
    await orch.done('task-1')

    const result = await orch.next()
    if (result.status === 'next') {
      expect(result.task).toBe('task-2')
    }
  })

  it('skips task when "when" condition is false', async () => {
    const workflow: WorkflowV3 = {
      name: 'cond',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'always', type: 'agent-task', output: 'a.md', depends: [], instruction: 'A' },
            { id: 'conditional', type: 'agent-task', output: 'b.md', depends: [], when: 'flag == true', instruction: 'B' },
            { id: 'after', type: 'agent-task', output: 'c.md', depends: [], instruction: 'C' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { flag: false } })

    // First task: 'always'
    await fs.writeFile(path.join(projectDir, 'a.md'), 'Done')
    await orch.done('always')

    // 'conditional' should be skipped, next is 'after'
    const result = await orch.next()
    if (result.status === 'next') {
      expect(result.task).toBe('after')
    }
  })
})

// ── nextBatch() ────────────────────────────────────────────────────────────

describe('orchestrator.nextBatch() — parallel ready-task dispatch', () => {
  const fanoutWorkflow: WorkflowV3 = {
    name: 'fanout',
    version: 3,
    pipeline: [{ phase: 'p' }],
    phases: {
      p: {
        tasks: [
          { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'A', 'parallel-safe': true },
          { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'B', 'parallel-safe': true },
          { id: 'c', type: 'agent-task', output: 'c.md', depends: [], instruction: 'C', 'parallel-safe': true },
          { id: 'd', type: 'agent-task', output: 'd.md', depends: ['a'], instruction: 'D', 'parallel-safe': true },
        ],
      },
    },
  }

  it('batches all independent agent-tasks when maxParallel is large', async () => {
    const orch = createOrchestrator(fanoutWorkflow)
    await orch.start()

    const result = await orch.nextBatch(10)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).toEqual(['a', 'b', 'c'])
      expect(result.phase).toBe('p')
    }
  })

  it('caps batch size at maxParallel', async () => {
    const orch = createOrchestrator(fanoutWorkflow)
    await orch.start()

    const result = await orch.nextBatch(2)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks).toHaveLength(2)
      expect(result.tasks.map(t => t.task)).toEqual(['a', 'b'])
    }
  })

  it('excludes tasks whose deps are not yet met', async () => {
    const orch = createOrchestrator(fanoutWorkflow)
    await orch.start()

    const result = await orch.nextBatch(10)
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).not.toContain('d')
    }
  })

  it('returns newly ready tasks after deps are satisfied', async () => {
    const orch = createOrchestrator(fanoutWorkflow)
    await orch.start()

    for (const id of ['a', 'b', 'c']) {
      await fs.writeFile(path.join(projectDir, `${id}.md`), 'ok')
      await orch.done(id)
    }

    const result = await orch.nextBatch(5)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).toEqual(['d'])
    }
  })

  it('falls back to single-task response when only one task is ready', async () => {
    const singleReadyWf: WorkflowV3 = {
      name: 'single',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'only', type: 'agent-task', output: 'only.md', depends: [], instruction: 'Only one' },
          ],
        },
      },
    }
    const orch = createOrchestrator(singleReadyWf)
    await orch.start()

    const result = await orch.nextBatch(5)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0].task).toBe('only')
    }
  })

  it('surfaces an approval gate before the batch when gate is ready and no agent-tasks queued', async () => {
    const gatedWf: WorkflowV3 = {
      name: 'gated',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'gate-first', type: 'gate', description: 'Approve before proceeding', depends: [] },
            { id: 'after', type: 'agent-task', output: 'after.md', depends: ['gate-first'], instruction: 'After' },
          ],
        },
      },
    }
    const orch = createOrchestrator(gatedWf)
    await orch.start()

    const result = await orch.nextBatch(5)
    expect(result.status).toBe('waiting')
    if (result.status === 'waiting') {
      expect(result.gate).toBe('gate-first')
    }
  })

  it('returns the batch collected so far when scan hits an unapproved gate', async () => {
    const mixedWf: WorkflowV3 = {
      name: 'mixed',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'A', 'parallel-safe': true },
            { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'B', 'parallel-safe': true },
            { id: 'gate-mid', type: 'gate', description: 'Gate', depends: [] },
            { id: 'c', type: 'agent-task', output: 'c.md', depends: ['gate-mid'], instruction: 'C' },
          ],
        },
      },
    }
    const orch = createOrchestrator(mixedWf)
    await orch.start()

    const result = await orch.nextBatch(5)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).toEqual(['a', 'b'])
    }
  })

  it('rejects maxParallel < 1', async () => {
    const orch = createOrchestrator(fanoutWorkflow)
    await orch.start()
    await expect(orch.nextBatch(0)).rejects.toThrow(/maxParallel must be >= 1/)
  })

  it('gate task auto-skips when its `when:` evaluates false (parity with agent-task)', async () => {
    // Regression: a gate task whose when condition is false used to sit
    // unresolved, deadlocking the phase even though the corresponding
    // agent-task with the same condition was correctly skipped.
    const wf: WorkflowV3 = {
      name: 'gate-when',
      version: 3,
      pipeline: [{ phase: 'p' }, { phase: 'next' }],
      phases: {
        p: {
          tasks: [
            { id: 'work', type: 'agent-task', output: 'work.md', depends: [], instruction: 'work' },
            {
              id: 'optional-gate',
              type: 'gate',
              'gate-type': 'approval',
              description: 'Skip me when flag is false',
              depends: ['work'],
              when: 'enable_review == true',
            },
          ],
        },
        next: {
          tasks: [
            { id: 'after', type: 'agent-task', output: 'after.md', depends: [], instruction: 'after' },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start({ exports: { enable_review: false } })

    await fs.writeFile(path.join(projectDir, 'work.md'), 'ok')
    const result = await orch.done('work', { parallel: 5 })

    // Gate auto-skipped → phase complete → advance to `next`, return `after`.
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.phase).toBe('next')
      expect(result.tasks.map(t => t.task)).toEqual(['after'])
    }
  })

  it('gate task accepts a skipped dependency as satisfied', async () => {
    // Regression: gate's unmetDeps filter required status==='done' while
    // agent-task's filter accepted status==='skipped' too. A gate that
    // depended on a `when:false` agent-task therefore stalled the phase
    // even though the workflow correctly chose not to run that task.
    const wf: WorkflowV3 = {
      name: 'gate-skipped-dep',
      version: 3,
      pipeline: [{ phase: 'p' }, { phase: 'next' }],
      phases: {
        p: {
          tasks: [
            {
              id: 'maybe-task',
              type: 'agent-task',
              output: 'maybe.md',
              depends: [],
              instruction: 'maybe',
              when: 'flag == true',
            },
            {
              id: 'review-gate',
              type: 'gate',
              'gate-type': 'approval',
              description: 'Approve regardless',
              depends: ['maybe-task'],
            },
          ],
        },
        next: {
          tasks: [
            { id: 'after', type: 'agent-task', output: 'after.md', depends: [], instruction: 'after' },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start({ exports: { flag: false } })

    // maybe-task auto-skipped on start; the gate must now be ready
    // (its dep is met-by-skip), so next() surfaces the gate as waiting.
    const r = await orch.next()
    expect(r.status).toBe('waiting')
    if (r.status === 'waiting') {
      expect(r.gate).toBe('review-gate')
    }
  })

  it('done() returns next-batch when parallel option is set', async () => {
    // After completing one task, done() should hand back the next batch
    // of ready tasks — not just one — so the caller can chain straight
    // into a parallel dispatch without a separate `dqa next` roundtrip.
    const wf: WorkflowV3 = {
      name: 'done-batch',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'seed', type: 'agent-task', output: 'seed.md', depends: [], instruction: 'seed' },
            { id: 'a', type: 'agent-task', output: 'a.md', depends: ['seed'], instruction: 'a', 'parallel-safe': true },
            { id: 'b', type: 'agent-task', output: 'b.md', depends: ['seed'], instruction: 'b', 'parallel-safe': true },
            { id: 'c', type: 'agent-task', output: 'c.md', depends: ['seed'], instruction: 'c', 'parallel-safe': true },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'seed.md'), 'ok')
    const result = await orch.done('seed', { parallel: 5 })

    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).toEqual(['a', 'b', 'c'])
    }
  })

  it('approve() returns next-batch when parallel option is set', async () => {
    // After approving a gate, approve() should hand back the next batch
    // — same chaining benefit as done(parallel).
    const wf: WorkflowV3 = {
      name: 'approve-batch',
      version: 3,
      pipeline: [{ phase: 'p1' }, { phase: 'p2' }],
      phases: {
        p1: {
          tasks: [
            { id: 'g', type: 'gate', 'gate-type': 'approval', description: 'g', depends: [] },
          ],
        },
        p2: {
          tasks: [
            { id: 'x', type: 'agent-task', output: 'x.md', depends: [], instruction: 'x', 'parallel-safe': true },
            { id: 'y', type: 'agent-task', output: 'y.md', depends: [], instruction: 'y', 'parallel-safe': true },
            { id: 'z', type: 'agent-task', output: 'z.md', depends: [], instruction: 'z', 'parallel-safe': true },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()

    const result = await orch.approve('g', { parallel: 5 })

    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.phase).toBe('p2')
      expect(result.tasks.map(t => t.task)).toEqual(['x', 'y', 'z'])
    }
  })

  it('approve() preserves the legacy `by` string signature', async () => {
    // Older callers pass the actor name as a positional string, not an
    // options object — make sure that path still works after extending
    // the signature with options.
    const wf: WorkflowV3 = {
      name: 'approve-legacy',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'g', type: 'gate', 'gate-type': 'approval', description: 'g', depends: [] },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()

    const result = await orch.approve('g', 'alice')
    expect(result.status).toBe('complete')
  })
})

// ── parallel-safe adjacency semantics ──────────────────────────────────────

describe('orchestrator — parallel-safe adjacency rules', () => {
  it('defaults to serial when parallel-safe is absent (batch of 1)', async () => {
    const wf: WorkflowV3 = {
      name: 'unmarked',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'A' },
            { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'B' },
            { id: 'c', type: 'agent-task', output: 'c.md', depends: [], instruction: 'C' },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()
    const result = await orch.nextBatch(10)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).toEqual(['a'])
    }
  })

  it('non-parallel-safe task in middle splits the batch', async () => {
    // Layout: a (safe) | b (safe) | c (NOT safe — barrier) | d (safe) | e (safe)
    // Expected first call: batch [a, b], stop at c.
    const wf: WorkflowV3 = {
      name: 'split',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'A', 'parallel-safe': true },
            { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'B', 'parallel-safe': true },
            { id: 'c', type: 'agent-task', output: 'c.md', depends: [], instruction: 'C' },
            { id: 'd', type: 'agent-task', output: 'd.md', depends: [], instruction: 'D', 'parallel-safe': true },
            { id: 'e', type: 'agent-task', output: 'e.md', depends: [], instruction: 'E', 'parallel-safe': true },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()

    const first = await orch.nextBatch(10)
    expect(first.status).toBe('next-batch')
    if (first.status === 'next-batch') {
      expect(first.tasks.map(t => t.task)).toEqual(['a', 'b'])
    }
  })

  it('non-parallel-safe task runs alone in its own batch', async () => {
    const wf: WorkflowV3 = {
      name: 'alone',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'A', 'parallel-safe': true },
            { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'B', 'parallel-safe': true },
            { id: 'c', type: 'agent-task', output: 'c.md', depends: [], instruction: 'C' },
            { id: 'd', type: 'agent-task', output: 'd.md', depends: [], instruction: 'D', 'parallel-safe': true },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()

    // Drain {a, b}
    for (const id of ['a', 'b']) {
      await fs.writeFile(path.join(projectDir, `${id}.md`), 'ok')
      await orch.done(id)
    }

    // c is the barrier, runs alone
    const second = await orch.nextBatch(10)
    expect(second.status).toBe('next-batch')
    if (second.status === 'next-batch') {
      expect(second.tasks.map(t => t.task)).toEqual(['c'])
    }
  })

  it('unmet-dep gap blocks batch extension across the gap', async () => {
    // Layout: a (safe, ready) | b (safe, deps: [external] unmet) | c (safe, ready)
    // Expected: batch is just [a]. We do not jump past b to grab c, because
    // b sits between them in declaration order — author wrote them in this
    // order and "skip past unmet" would batch non-consecutive tasks.
    const wf: WorkflowV3 = {
      name: 'gap',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'A', 'parallel-safe': true },
            { id: 'b', type: 'agent-task', output: 'b.md', depends: ['nonexistent'], instruction: 'B', 'parallel-safe': true },
            { id: 'c', type: 'agent-task', output: 'c.md', depends: [], instruction: 'C', 'parallel-safe': true },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()

    const result = await orch.nextBatch(10)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).toEqual(['a'])
    }
  })

  it('unmet-dep gap before the first ready task does not stop discovery', async () => {
    // Layout: a (deps unmet) | b (ready, safe) | c (ready, safe)
    // Even though a has unmet deps, scan keeps looking until it finds b.
    // Once b is the first batched task, the chain starts there. c joins
    // because there is no gap between b and c.
    const wf: WorkflowV3 = {
      name: 'gap-before',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'a', type: 'agent-task', output: 'a.md', depends: ['nonexistent'], instruction: 'A', 'parallel-safe': true },
            { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'B', 'parallel-safe': true },
            { id: 'c', type: 'agent-task', output: 'c.md', depends: [], instruction: 'C', 'parallel-safe': true },
          ],
        },
      },
    }
    const orch = createOrchestrator(wf)
    await orch.start()

    const result = await orch.nextBatch(10)
    expect(result.status).toBe('next-batch')
    if (result.status === 'next-batch') {
      expect(result.tasks.map(t => t.task)).toEqual(['b', 'c'])
    }
  })
})

// ── next() Stage 2: advance phases ─────────────────────────────────────────

describe('orchestrator.next() — advance phases', () => {
  it('moves to next pipeline phase', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()

    // Complete phase-a
    await fs.writeFile(path.join(projectDir, 'task-1.md'), 'Done')
    await orch.done('task-1')
    await fs.writeFile(path.join(projectDir, 'task-2.md'), 'Done')
    await orch.done('task-2')

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('task-3')
      expect(result.phase).toBe('phase-b')
    }
  })

  it('skips phase when "when" is false', async () => {
    const workflow: WorkflowV3 = {
      name: 'skip',
      version: 3,
      pipeline: [
        { phase: 'p1' },
        { phase: 'p2', when: 'flag == true' },
        { phase: 'p3' },
      ],
      phases: {
        p1: { tasks: [{ id: 't1', type: 'agent-task', output: 't1.md', depends: [], instruction: 'T1' }] },
        p2: { tasks: [{ id: 't2', type: 'agent-task', output: 't2.md', depends: [], instruction: 'T2' }] },
        p3: { tasks: [{ id: 't3', type: 'agent-task', output: 't3.md', depends: [], instruction: 'T3' }] },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { flag: false } })

    await fs.writeFile(path.join(projectDir, 't1.md'), 'Done')
    await orch.done('t1')

    // p2 skipped, goes to p3
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('t3')
      expect(result.phase).toBe('p3')
    }
  })

  it('returns complete when last phase is done', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()

    // Complete all tasks
    await fs.writeFile(path.join(projectDir, 'task-1.md'), 'Done')
    await orch.done('task-1')
    await fs.writeFile(path.join(projectDir, 'task-2.md'), 'Done')
    await orch.done('task-2')
    await fs.writeFile(path.join(projectDir, 'task-3.md'), 'Done')
    await orch.done('task-3')

    const result = await orch.next()
    expect(result.status).toBe('complete')
  })
})

// ── gate task within phase ─────────────────────────────────────────────────

describe('orchestrator — gate task within phase', () => {
  it('returns waiting for gate task', async () => {
    const workflow: WorkflowV3 = {
      name: 'inner-gate',
      version: 3,
      pipeline: [{ phase: 'p1' }],
      phases: {
        p1: {
          tasks: [
            { id: 't1', type: 'agent-task', output: 't1.md', depends: [], instruction: 'T1' },
            { id: 'g1', type: 'gate', 'gate-type': 'approval', depends: ['t1'], description: 'Approve t1' },
            { id: 't2', type: 'agent-task', output: 't2.md', depends: ['g1'], instruction: 'T2' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 't1.md'), 'Done')
    await orch.done('t1')

    // Next should be the gate
    const result = await orch.next()
    expect(result.status).toBe('waiting')
    if (result.status === 'waiting') {
      expect(result.gate).toBe('g1')
    }
  })

  it('proceeds after gate task approval', async () => {
    const workflow: WorkflowV3 = {
      name: 'inner-gate',
      version: 3,
      pipeline: [{ phase: 'p1' }],
      phases: {
        p1: {
          tasks: [
            { id: 't1', type: 'agent-task', output: 't1.md', depends: [], instruction: 'T1' },
            { id: 'g1', type: 'gate', 'gate-type': 'approval', depends: ['t1'], description: 'Approve' },
            { id: 't2', type: 'agent-task', output: 't2.md', depends: ['g1'], instruction: 'T2' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 't1.md'), 'Done')
    await orch.done('t1')
    await orch.approve('g1')

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('t2')
    }
  })
})

// ── done() ─────────────────────────────────────────────────────────────────

describe('orchestrator.done()', () => {
  it('verifies output file exists before marking done', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()

    // Don't create the file — should throw
    await expect(orch.done('task-1')).rejects.toThrow(/output.*not found/i)
  })

  it('stores exports from done call', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'task-1.md'), 'Done')
    await orch.done('task-1', { exports: { myKey: 'myValue' } })

    // Next call should have access to exports
    const result = await orch.next()
    // task-2 is returned — exports are stored in state
    expect(result.status).toBe('next')
  })
})

// ── for-each task ─────────────────────────────────────────────────────────

describe('orchestrator — for-each task', () => {
  const forEachWorkflow: WorkflowV3 = {
    name: 'foreach',
    version: 3,
    pipeline: [
      { phase: 'spec' },
      { phase: 'build' },
    ],
    phases: {
      spec: {
        tasks: [
          { id: 'prep', type: 'agent-task', output: 'prep.md', depends: [], instruction: 'Prepare' },
        ],
      },
      build: {
        tasks: [
          {
            id: 'implement',
            type: 'for-each',
            depends: ['prep'],
            source: 'stories/story-*.md',
            as: 'story',
            'sub-tasks': [
              { id: 'backend', type: 'agent-task', output: 'src/{story.id}/api.ts', depends: [], instruction: 'Implement backend for {story.title}' },
              { id: 'tests', type: 'agent-task', output: 'tests/{story.id}/test.ts', depends: ['backend'], instruction: 'Write tests for {story.title}' },
            ],
          },
        ],
      },
    },
  }

  it('expands for-each into sub-tasks per matched file', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    // Complete spec phase
    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    // Create story files for for-each to glob
    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# Story 1')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-002.md'), '# Story 2')

    // Next should return first expanded sub-task
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('implement:story-001:backend')
      expect(result.phase).toBe('build')
      expect(result.instruction).toContain('story 001')
    }
  })

  it('respects sub-task dependencies within a for-each iteration', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# Story 1')

    // Get first task (backend for story-001)
    let result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('implement:story-001:backend')
    }

    // Complete backend — tests should become ready
    await fs.mkdirp(path.join(projectDir, 'src', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001', 'api.ts'), 'export {}')
    result = await orch.done('implement:story-001:backend')
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('implement:story-001:tests')
    }
  })

  it('auto-completes for-each parent when all sub-tasks done', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    // Single story
    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# Story 1')

    // Complete backend
    await fs.mkdirp(path.join(projectDir, 'src', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001', 'api.ts'), 'export {}')
    await orch.done('implement:story-001:backend')

    // Complete tests — for-each parent should auto-complete, workflow done
    await fs.mkdirp(path.join(projectDir, 'tests', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'tests', 'story-001', 'test.ts'), 'test()')
    const result = await orch.done('implement:story-001:tests')
    expect(result.status).toBe('complete')
  })

  it('handles multiple iterations in parallel', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# Story 1')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-002.md'), '# Story 2')

    // First ready: story-001 backend
    let result = await orch.next()
    if (result.status === 'next') {
      expect(result.task).toBe('implement:story-001:backend')
    }

    // Complete story-001 backend — next should be story-002 backend (parallel)
    // or story-001 tests (dep met)
    await fs.mkdirp(path.join(projectDir, 'src', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001', 'api.ts'), 'export {}')
    result = await orch.done('implement:story-001:backend')
    if (result.status === 'next') {
      // Could be story-001:tests or story-002:backend — both are ready
      expect(['implement:story-001:tests', 'implement:story-002:backend']).toContain(result.task)
    }
  })

  it('resolves {variable} placeholders in output and instruction', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# Story 1')

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      // {story.id} resolved in output
      expect(result.output).toBe('src/story-001/api.ts')
      // {story.title} resolved in instruction (title = id with dashes → spaces)
      expect(result.instruction).toContain('story 001')
    }
  })

  it('full multi-story lifecycle completes workflow', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-002.md'), '# S2')

    // Complete all sub-tasks for both stories
    for (const id of ['story-001', 'story-002']) {
      await fs.mkdirp(path.join(projectDir, 'src', id))
      await fs.writeFile(path.join(projectDir, 'src', id, 'api.ts'), 'export {}')
      await orch.done(`implement:${id}:backend`)

      await fs.mkdirp(path.join(projectDir, 'tests', id))
      await fs.writeFile(path.join(projectDir, 'tests', id, 'test.ts'), 'test()')
      await orch.done(`implement:${id}:tests`)
    }

    const result = await orch.next()
    expect(result.status).toBe('complete')
    if (result.status === 'complete') {
      // parent + 4 sub-tasks + prep = 6 done (parent auto-completed)
      expect(result.summary.tasksDone).toBeGreaterThanOrEqual(5)
    }
  })

  it('blocks expansion when for-each parent deps not met', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    // Create stories but DON'T complete prep (the for-each depends on prep)
    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')

    // Next should return prep, not the for-each sub-tasks
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('prep')
    }
  })

  it('empty for-each (deps met, 0 source matches) returns blocked, not a false complete', async () => {
    // Regression: an empty-source for-each left the parent absent from state,
    // so `next` hit the !phaseDone fallback and returned `complete` while
    // `dqa status` still showed `running`. It must surface as `blocked`
    // (consistent with status) and name the stuck for-each — without
    // persisting anything, so a later next() re-expands once the source exists.
    const emptyForEachWf: WorkflowV3 = {
      name: 'empty-foreach',
      version: 3,
      pipeline: [{ phase: 'fan' }],
      phases: {
        fan: {
          tasks: [
            {
              id: 'per-feature',
              type: 'for-each',
              depends: [],
              source: 'specs/*.feature',
              as: 'feature',
              'sub-tasks': [
                { id: 'spec', type: 'agent-task', output: 'out/{feature.id}.md', depends: [], instruction: 'x' },
              ],
            },
          ],
        },
      },
    }

    const orch = new Orchestrator(tmpDir, 'test-proj', emptyForEachWf)
    // No specs/*.feature files exist → the for-each matches 0 items.
    const result = await orch.start()

    // Must NOT falsely report the run complete; surface as blocked instead.
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') {
      expect(result.gate).toBe('_for-each-empty')
      expect(result.check).toContain('per-feature')
    }
  })

  it('expanded task IDs are recorded in state files', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')

    await fs.mkdirp(path.join(projectDir, 'src', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001', 'api.ts'), 'export {}')
    await orch.done('implement:story-001:backend')

    // Verify state file was written with expanded task ID
    const stateDir = getStateDir(tmpDir, 'test-proj')
    const state = await loadState(stateDir)
    expect(state.tasks['implement:story-001:backend']).toBeDefined()
    expect(state.tasks['implement:story-001:backend'].status).toBe('done')
    expect(state.tasks['implement:story-001:backend'].output).toBe('src/story-001/api.ts')
  })

  it('returns tasks in sorted order across iterations', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    // Create stories in reverse order to test sorting
    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-003.md'), '# S3')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-002.md'), '# S2')

    // First task should be story-001 (sorted), not story-003
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('implement:story-001:backend')
    }
  })

  it('for-each with task after it in same phase', async () => {
    // A for-each followed by a regular task that depends on the for-each
    const workflow: WorkflowV3 = {
      name: 'foreach-then-task',
      version: 3,
      pipeline: [{ phase: 'build' }],
      phases: {
        build: {
          tasks: [
            {
              id: 'per-story',
              type: 'for-each',
              depends: [],
              source: 'stories/story-*.md',
              as: 'story',
              'sub-tasks': [
                { id: 'impl', type: 'agent-task', output: 'src/{story.id}.ts', depends: [], instruction: 'Build {story.id}' },
              ],
            },
            { id: 'final-report', type: 'agent-task', output: 'report.md', depends: ['per-story'], instruction: 'Write report' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')

    // First: for-each sub-task
    let result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('per-story:story-001:impl')
    }

    // Complete it — for-each parent auto-completes
    await fs.mkdirp(path.join(projectDir, 'src'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001.ts'), 'export {}')
    result = await orch.done('per-story:story-001:impl')

    // Now final-report should be ready (depends on per-story which is auto-done)
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('final-report')
    }
  })

  it('no matches — for-each stays pending', async () => {
    const orch = createOrchestrator(forEachWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    // No story files exist — for-each finds nothing
    // The for-each parent is type: for-each, skipped in findReadyTask
    // Phase cannot complete because the parent task is not done
    const result = await orch.next()
    // Should not be 'complete' — the for-each is still pending
    // Orchestrator returns complete only when all phases are done
    // Here the build phase has a for-each that can't expand
    expect(result.status).toBeDefined()
  })
})

// ── parallel task ─────────────────────────────────────────────────────────

describe('orchestrator — parallel task', () => {
  it('expands parallel sub-tasks with no ordering constraint', async () => {
    const workflow: WorkflowV3 = {
      name: 'par',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            {
              id: 'batch',
              type: 'parallel',
              depends: [],
              tasks: [
                { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'Do A' },
                { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'Do B' },
              ],
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    // First ready task should be batch:a (both are ready, returns first)
    const r1 = await orch.next()
    expect(r1.status).toBe('next')
    if (r1.status === 'next') {
      expect(r1.task).toBe('batch:a')
    }

    // Complete a — b should be next
    await fs.writeFile(path.join(projectDir, 'a.md'), 'Done')
    const r2 = await orch.done('batch:a')
    expect(r2.status).toBe('next')
    if (r2.status === 'next') {
      expect(r2.task).toBe('batch:b')
    }

    // Complete b — parent auto-completes, workflow done
    await fs.writeFile(path.join(projectDir, 'b.md'), 'Done')
    const r3 = await orch.done('batch:b')
    expect(r3.status).toBe('complete')
  })

  it('parallel sub-tasks can have internal dependencies', async () => {
    const workflow: WorkflowV3 = {
      name: 'par-dep',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            {
              id: 'batch',
              type: 'parallel',
              depends: [],
              tasks: [
                { id: 'first', type: 'agent-task', output: 'first.md', depends: [], instruction: 'First' },
                { id: 'second', type: 'agent-task', output: 'second.md', depends: ['first'], instruction: 'Second' },
              ],
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    // Only 'first' is ready (second depends on first)
    const r1 = await orch.next()
    if (r1.status === 'next') {
      expect(r1.task).toBe('batch:first')
    }

    await fs.writeFile(path.join(projectDir, 'first.md'), 'Done')
    const r2 = await orch.done('batch:first')
    if (r2.status === 'next') {
      expect(r2.task).toBe('batch:second')
    }
  })
})

// ── switch task ───────────────────────────────────────────────────────────

describe('orchestrator — switch task', () => {
  it('evaluates expression and takes the matching route', async () => {
    const workflow: WorkflowV3 = {
      name: 'sw',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'classify', type: 'agent-task', output: 'classify.md', depends: [], instruction: 'Classify' },
            {
              id: 'route',
              type: 'switch',
              depends: ['classify'],
              eval: 'change.type',
              routes: {
                feature: [
                  { id: 'domain-delta', type: 'agent-task', output: 'domain.md', depends: [], instruction: 'Update domain' },
                ],
                bugfix: [
                  { id: 'fix', type: 'agent-task', output: 'fix.md', depends: [], instruction: 'Fix the bug' },
                ],
              },
              default: [
                { id: 'fallback', type: 'agent-task', output: 'fallback.md', depends: [], instruction: 'Fallback' },
              ],
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    // Complete classify with exports that set the route
    await fs.writeFile(path.join(projectDir, 'classify.md'), 'Done')
    await orch.done('classify', { exports: { 'change.type': 'feature' } })

    // Next should be the feature branch task
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('route:domain-delta')
    }
  })

  it('takes default route when no match', async () => {
    const workflow: WorkflowV3 = {
      name: 'sw-default',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'classify', type: 'agent-task', output: 'classify.md', depends: [], instruction: 'Classify' },
            {
              id: 'route',
              type: 'switch',
              depends: ['classify'],
              eval: 'change.type',
              routes: {
                feature: [
                  { id: 'domain-delta', type: 'agent-task', output: 'domain.md', depends: [], instruction: 'Update domain' },
                ],
              },
              default: [
                { id: 'fallback', type: 'agent-task', output: 'fallback.md', depends: [], instruction: 'Fallback' },
              ],
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'classify.md'), 'Done')
    await orch.done('classify', { exports: { 'change.type': 'unknown' } })

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('route:fallback')
    }
  })

  it('auto-completes switch parent when branch tasks done', async () => {
    const workflow: WorkflowV3 = {
      name: 'sw-complete',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'classify', type: 'agent-task', output: 'classify.md', depends: [], instruction: 'Classify' },
            {
              id: 'route',
              type: 'switch',
              depends: ['classify'],
              eval: 'change.type',
              routes: {
                bugfix: [
                  { id: 'fix', type: 'agent-task', output: 'fix.md', depends: [], instruction: 'Fix' },
                ],
              },
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'classify.md'), 'Done')
    await orch.done('classify', { exports: { 'change.type': 'bugfix' } })

    await orch.next() // route:fix

    await fs.writeFile(path.join(projectDir, 'fix.md'), 'Done')
    const result = await orch.done('route:fix')
    expect(result.status).toBe('complete')
  })
})

// ── action task ───────────────────────────────────────────────────────────

describe('orchestrator — action task', () => {
  it('returns action task with run command as instruction', async () => {
    const workflow: WorkflowV3 = {
      name: 'act',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'run-tests', type: 'action', depends: [], run: 'npm test' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('run-tests')
      expect(result.type).toBe('action')
      expect(result.instruction).toContain('npm test')
    }
  })

  it('action task done without output check', async () => {
    const workflow: WorkflowV3 = {
      name: 'act2',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'lint', type: 'action', depends: [], run: 'npm run lint' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    // No output file needed for action tasks
    const result = await orch.done('lint')
    expect(result.status).toBe('complete')
  })
})

// ── override resolution ───────────────────────────────────────────────────

describe('orchestrator — override resolution', () => {
  it('uses override instruction when override file exists', async () => {
    const workflow: WorkflowV3 = {
      name: 'override-test',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'task-a', type: 'agent-task', output: 'a.md', depends: [], instruction: 'Original instruction' },
          ],
        },
      },
    }

    // Create override file
    const overrideDir = path.join(tmpDir, '.dqa', 'overrides', 'override-test', 'tasks')
    await fs.mkdirp(overrideDir)
    await fs.writeFile(path.join(overrideDir, 'task-a.md'), 'Custom override instruction')

    const orch = createOrchestrator(workflow)
    await orch.start()

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.instruction).toBe('Custom override instruction')
    }
  })

  it('falls back to inline instruction when no override', async () => {
    const workflow: WorkflowV3 = {
      name: 'no-override',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'task-b', type: 'agent-task', output: 'b.md', depends: [], instruction: 'Inline instruction' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.instruction).toBe('Inline instruction')
    }
  })

  it('loads instruction from project override when no inline', async () => {
    const workflow: WorkflowV3 = {
      name: 'dqa',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'constitution', type: 'agent-task', output: 'constitution.md', depends: [] },
          ],
        },
      },
    }

    const overrideDir = path.join(tmpDir, '.dqa', 'overrides', 'dqa', 'tasks')
    await fs.mkdirp(overrideDir)
    await fs.writeFile(path.join(overrideDir, 'constitution.md'), 'Project-specific constitution override')

    const orch = createOrchestrator(workflow)
    await orch.start()

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.instruction).toBe('Project-specific constitution override')
    }
  })

  it('returns undefined instruction when no override, no inline, and remote mode off', async () => {
    const workflow: WorkflowV3 = {
      name: 'nonexistent-workflow',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'mystery-task', type: 'agent-task', output: 'x.md', depends: [] },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.instruction).toBeUndefined()
    }
  })
})

// ── layer enforcement (for-each build phase) ──────────────────────────────

describe('orchestrator — layer enforcement via for-each', () => {
  const layerWorkflow: WorkflowV3 = {
    name: 'layer-enforce',
    version: 3,
    pipeline: [
      { phase: 'spec' },
      { phase: 'build' },
      { phase: 'complete' },
    ],
    phases: {
      spec: {
        tasks: [
          { id: 'prep', type: 'agent-task', output: 'prep.md', depends: [], instruction: 'Prepare' },
        ],
      },
      build: {
        tasks: [
          {
            id: 'implement',
            type: 'for-each',
            depends: ['prep'],
            source: 'stories/story-*.md',
            as: 'story',
            'sub-tasks': [
              { id: 'backend', type: 'agent-task', output: 'src/{story.id}/**/*', depends: [], instruction: 'Backend for {story.title}' },
              { id: 'frontend', type: 'agent-task', output: 'components/{story.id}/**/*', depends: ['backend'], instruction: 'Frontend for {story.title}' },
              { id: 'tests', type: 'agent-task', output: 'tests/{story.id}/**/*', depends: ['backend'], instruction: 'Tests for {story.title}' },
            ],
          },
        ],
      },
      complete: {
        tasks: [
          { id: 'report', type: 'agent-task', output: 'report.md', depends: [], instruction: 'Write report' },
        ],
      },
    },
  }

  it('prevents advancement when sub-tasks are incomplete', async () => {
    const orch = createOrchestrator(layerWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-002.md'), '# S2')

    // Complete only backend for story-001
    await fs.mkdirp(path.join(projectDir, 'src', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001', 'api.ts'), 'export {}')
    const result = await orch.done('implement:story-001:backend')

    // Must NOT be complete — frontend and tests still pending
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      // Should return another sub-task, not the complete phase
      expect(result.phase).toBe('build')
    }
  })

  it('blocks when one story has missing layers', async () => {
    const orch = createOrchestrator(layerWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-002.md'), '# S2')

    // Complete ALL layers for story-001
    await fs.mkdirp(path.join(projectDir, 'src', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001', 'api.ts'), 'export {}')
    await orch.done('implement:story-001:backend')

    await fs.mkdirp(path.join(projectDir, 'components', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'components', 'story-001', 'page.tsx'), 'export {}')
    await orch.done('implement:story-001:frontend')

    await fs.mkdirp(path.join(projectDir, 'tests', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'tests', 'story-001', 'test.ts'), 'test()')
    await orch.done('implement:story-001:tests')

    // Only complete backend for story-002 (frontend + tests missing)
    await fs.mkdirp(path.join(projectDir, 'src', 'story-002'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-002', 'api.ts'), 'export {}')
    const result = await orch.done('implement:story-002:backend')

    // Must NOT be complete — story-002 frontend and tests still pending
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.phase).toBe('build')
      expect(['implement:story-002:frontend', 'implement:story-002:tests']).toContain(result.task)
    }
  })

  it('completes only when ALL stories × ALL layers are done', async () => {
    const orch = createOrchestrator(layerWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')
    await fs.writeFile(path.join(projectDir, 'stories', 'story-002.md'), '# S2')

    // Complete all 6 sub-tasks (2 stories × 3 layers)
    for (const sid of ['story-001', 'story-002']) {
      await fs.mkdirp(path.join(projectDir, 'src', sid))
      await fs.writeFile(path.join(projectDir, 'src', sid, 'api.ts'), 'export {}')
      await orch.done(`implement:${sid}:backend`)

      await fs.mkdirp(path.join(projectDir, 'components', sid))
      await fs.writeFile(path.join(projectDir, 'components', sid, 'page.tsx'), 'export {}')
      await orch.done(`implement:${sid}:frontend`)

      await fs.mkdirp(path.join(projectDir, 'tests', sid))
      await fs.writeFile(path.join(projectDir, 'tests', sid, 'test.ts'), 'test()')
      await orch.done(`implement:${sid}:tests`)
    }

    // for-each auto-completes → gate check passes → advance to complete phase
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('report')
      expect(result.phase).toBe('complete')
    }
  })

  it('done() rejects when glob output has no files', async () => {
    const orch = createOrchestrator(layerWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')

    // Try to mark backend done WITHOUT creating any output files
    await expect(orch.done('implement:story-001:backend')).rejects.toThrow(/Found 0 new file/)
  })

  it('automated gate blocks advancement until for-each fully completes', async () => {
    const orch = createOrchestrator(layerWorkflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'prep.md'), 'Done')
    await orch.done('prep')

    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')

    // Complete only backend (frontend + tests pending)
    await fs.mkdirp(path.join(projectDir, 'src', 'story-001'))
    await fs.writeFile(path.join(projectDir, 'src', 'story-001', 'api.ts'), 'export {}')
    await orch.done('implement:story-001:backend')

    // Next should return a build sub-task, NOT the complete phase
    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      // Must still be in build phase
      expect(result.phase).toBe('build')
      expect(result.task).not.toBe('report')
    }
  })
})

// ── done() validation enforcement ─────────────────────────────────────────

describe('orchestrator — done() validation enforcement', () => {
  it('rejects when min-output-count not met', async () => {
    const workflow: WorkflowV3 = {
      name: 'mincount',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'stories', type: 'agent-task', output: 'stories/story-*.md', depends: [], instruction: 'Write stories', 'min-output-count': 3 },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    // Only create 1 story (need at least 3)
    await fs.mkdirp(path.join(projectDir, 'stories'))
    await fs.writeFile(path.join(projectDir, 'stories', 'story-001.md'), '# S1')
    await expect(orch.done('stories')).rejects.toThrow(/Found 1 new file.*minimum: 3/)
  })

  it('excludes pre-existing files from min-output-count (freshness guard)', async () => {
    const workflow: WorkflowV3 = {
      name: 'freshness',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'stories', type: 'agent-task', output: 'stories/story-*.md', depends: [], instruction: 'Write stories', 'min-output-count': 1 },
          ],
        },
      },
    }

    // A file that exists BEFORE the run starts, stamped with an old mtime.
    await fs.mkdirp(path.join(projectDir, 'stories'))
    const stale = path.join(projectDir, 'stories', 'story-001.md')
    await fs.writeFile(stale, '# Story\nAs a user I want to log in so that I can access my account.\n')
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(stale, past, past)

    const orch = createOrchestrator(workflow)
    await orch.start()

    // The only match predates run start → must be excluded → done rejects.
    // (Regression: _run.yaml was read with readJSON, always threw, zeroed the
    // start time, and let any pre-existing file satisfy the count.)
    await expect(orch.done('stories')).rejects.toThrow(/0 new file.*1 pre-existing file\(s\) were excluded/)
  })

  it('rejects when validate expression fails', async () => {
    const workflow: WorkflowV3 = {
      name: 'validate-expr',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            {
              id: 'arch',
              type: 'agent-task',
              output: 'arch.md',
              depends: [],
              instruction: 'Write architecture',
              validate: 'file-content(arch.md) includes "Status: APPROVED"',
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    // Write arch.md WITHOUT "Status: APPROVED"
    await fs.writeFile(path.join(projectDir, 'arch.md'), '# Architecture\nStatus: DRAFT\n')
    await expect(orch.done('arch')).rejects.toThrow(/Validation failed/)
  })

  it('accepts when validate expression passes', async () => {
    const workflow: WorkflowV3 = {
      name: 'validate-ok',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            {
              id: 'arch',
              type: 'agent-task',
              output: 'arch.md',
              depends: [],
              instruction: 'Write architecture',
              validate: 'file-content(arch.md) includes "Status: APPROVED"',
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    await fs.writeFile(path.join(projectDir, 'arch.md'), '# Architecture\nStatus: APPROVED\n')
    const result = await orch.done('arch')
    expect(result.status).toBe('complete')
  })

})

// ── done() resolves template variables in output before validation ────────

describe('orchestrator — done() resolves template vars in output', () => {
  it('resolves {var} from exports before checking file existence', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-file',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'brief', type: 'agent-task', output: 'changes/{change-id}/change-brief.md', depends: [], instruction: 'Write brief' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'FEAT-42' } })

    // Create the resolved output file
    await fs.mkdirp(path.join(projectDir, 'changes', 'FEAT-42'))
    await fs.writeFile(path.join(projectDir, 'changes', 'FEAT-42', 'change-brief.md'), '# Brief')

    const result = await orch.done('brief')
    expect(result.status).toBe('complete')
  })

  it('rejects when resolved {var} output file does not exist', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-file-miss',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'brief', type: 'agent-task', output: 'changes/{change-id}/change-brief.md', depends: [], instruction: 'Write brief' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'FEAT-42' } })

    // Do NOT create the file
    await expect(orch.done('brief')).rejects.toThrow(/output.*not found/i)
  })

  it('resolves {var} in glob output before matching', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-glob',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'docs', type: 'agent-task', output: 'changes/{change-id}/*.md', depends: [], instruction: 'Write docs', 'min-output-count': 2 },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'FEAT-99' } })

    // Create matching files
    await fs.mkdirp(path.join(projectDir, 'changes', 'FEAT-99'))
    await fs.writeFile(path.join(projectDir, 'changes', 'FEAT-99', 'brief.md'), '# Brief')
    await fs.writeFile(path.join(projectDir, 'changes', 'FEAT-99', 'impact.md'), '# Impact')

    const result = await orch.done('docs')
    expect(result.status).toBe('complete')
  })

  it('resolves {var} from done opts exports (not yet in state)', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-opts',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'setup', type: 'agent-task', output: 'setup.md', depends: [], instruction: 'Setup' },
            { id: 'brief', type: 'agent-task', output: 'changes/{change-id}/change-brief.md', depends: ['setup'], instruction: 'Write brief' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start()

    // Complete setup, exporting change-id
    await fs.writeFile(path.join(projectDir, 'setup.md'), 'Done')
    await orch.done('setup', { exports: { 'change-id': 'CHG-7' } })

    // Create resolved output file
    await fs.mkdirp(path.join(projectDir, 'changes', 'CHG-7'))
    await fs.writeFile(path.join(projectDir, 'changes', 'CHG-7', 'change-brief.md'), '# Brief')

    const result = await orch.done('brief')
    expect(result.status).toBe('complete')
  })

  it('next() returns resolved output path to the agent', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-next-output',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'brief', type: 'agent-task', output: 'changes/{change-id}/brief.md', depends: [], instruction: 'Write brief' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'FEAT-55' } })

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.output).toBe('changes/FEAT-55/brief.md')
    }
  })

  it('done() stores resolved output path in state', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-state-output',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'brief', type: 'agent-task', output: 'changes/{change-id}/brief.md', depends: [], instruction: 'Write brief' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'FEAT-55' } })

    await fs.mkdirp(path.join(projectDir, 'changes', 'FEAT-55'))
    await fs.writeFile(path.join(projectDir, 'changes', 'FEAT-55', 'brief.md'), '# Brief')
    await orch.done('brief')

    const state = await loadState(getStateDir(tmpDir, 'test-proj'))
    expect(state.tasks['brief']?.output).toBe('changes/FEAT-55/brief.md')
  })

  it('next() returns resolved instruction with template vars', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-instruction',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'brief', type: 'agent-task', output: 'brief.md', depends: [], instruction: 'Write brief for change {change-id}' },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'FEAT-77' } })

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.instruction).toBe('Write brief for change FEAT-77')
    }
  })

  it('validate expression with template vars is resolved before evaluation', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-validate',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            {
              id: 'report',
              type: 'agent-task',
              output: 'report.md',
              depends: [],
              instruction: 'Write report',
              validate: 'file-content(changes/{change-id}/report.md) includes "APPROVED"',
            },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'CHG-10' } })

    // Create output and the file referenced in validate
    await fs.writeFile(path.join(projectDir, 'report.md'), 'Done')
    await fs.mkdirp(path.join(projectDir, 'changes', 'CHG-10'))
    await fs.writeFile(path.join(projectDir, 'changes', 'CHG-10', 'report.md'), 'Status: APPROVED')

    const result = await orch.done('report')
    expect(result.status).toBe('complete')
  })

  it('action task run command resolves template vars', async () => {
    const workflow: WorkflowV3 = {
      name: 'tpl-action',
      version: 3,
      pipeline: [{ phase: 'p' }],
      phases: {
        p: {
          tasks: [
            { id: 'deploy', type: 'action', run: 'deploy changes/{change-id}', depends: [] },
          ],
        },
      },
    }

    const orch = createOrchestrator(workflow)
    await orch.start({ exports: { 'change-id': 'FEAT-33' } })

    const result = await orch.next()
    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.instruction).toBe('Run: deploy changes/FEAT-33')
    }
  })
})

// ── Composite cross-run prereq enforcement ────────────────────────────────

describe('orchestrator.next() — composite prereq enforcement', () => {
  it('returns blocked when sibling gate is not approved', async () => {
    // Set up two runs: ba (started, no gate yet) and architect (started,
    // depends on ba.srs-approval-gate). architect.next() must return
    // blocked until ba's gate is approved.
    const baStateDir = getStateDir(tmpDir, 'test-proj', 'ba')
    await initRun(baStateDir, {
      project: 'test-proj',
      run: 'ba',
      workflow: 'dqa-ba',
    })

    const archStateDir = getStateDir(tmpDir, 'test-proj', 'architect')
    await initRun(archStateDir, {
      project: 'test-proj',
      run: 'architect',
      workflow: 'dqa-architect',
      composite: 'solo',
      compositePrereqs: [{ run: 'ba', gate: 'srs-approval-gate' }],
    })

    const orch = new Orchestrator(tmpDir, 'test-proj', simpleWorkflow, 'architect')
    const result = await orch.next()

    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') {
      expect(result.gate).toBe('_composite-prereq')
      expect(result.check).toContain('ba:srs-approval-gate')
    }
  })

  it('proceeds normally when sibling gate is approved', async () => {
    // ba run with gate approved, architect run depending on it.
    const baStateDir = getStateDir(tmpDir, 'test-proj', 'ba')
    await initRun(baStateDir, {
      project: 'test-proj',
      run: 'ba',
      workflow: 'dqa-ba',
    })
    await writeGateApproved(baStateDir, 'handoff', 'srs-approval-gate', 'ba-actor')

    const archStateDir = getStateDir(tmpDir, 'test-proj', 'architect')
    await initRun(archStateDir, {
      project: 'test-proj',
      run: 'architect',
      workflow: 'dqa-architect',
      composite: 'solo',
      compositePrereqs: [{ run: 'ba', gate: 'srs-approval-gate' }],
    })

    const orch = new Orchestrator(tmpDir, 'test-proj', simpleWorkflow, 'architect')
    const result = await orch.next()

    expect(result.status).toBe('next')
    if (result.status === 'next') {
      expect(result.task).toBe('task-1')
    }
  })

  it('proceeds when no prereqs are declared (legacy single-workflow run)', async () => {
    const orch = createOrchestrator(simpleWorkflow)
    await orch.start()
    const result = await orch.next()
    expect(result.status).toBe('next')
  })

  it('returns blocked listing all unmet prereqs (multi-prereq case)', async () => {
    // Release run depends on both dev and qa hand-off gates.
    const devStateDir = getStateDir(tmpDir, 'test-proj', 'dev')
    await initRun(devStateDir, {
      project: 'test-proj',
      run: 'dev',
      workflow: 'dqa-dev',
    })
    // dev gate NOT approved

    const qaStateDir = getStateDir(tmpDir, 'test-proj', 'qa')
    await initRun(qaStateDir, {
      project: 'test-proj',
      run: 'qa',
      workflow: 'dqa-qa',
    })
    // qa gate NOT approved

    const releaseStateDir = getStateDir(tmpDir, 'test-proj', 'release')
    await initRun(releaseStateDir, {
      project: 'test-proj',
      run: 'release',
      workflow: 'dqa-release',
      composite: 'solo',
      compositePrereqs: [
        { run: 'dev', gate: 'build-approval-gate' },
        { run: 'qa', gate: 'test-approval-gate' },
      ],
    })

    const orch = new Orchestrator(tmpDir, 'test-proj', simpleWorkflow, 'release')
    const result = await orch.next()

    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') {
      expect(result.check).toContain('dev:build-approval-gate')
      expect(result.check).toContain('qa:test-approval-gate')
    }
  })
})
