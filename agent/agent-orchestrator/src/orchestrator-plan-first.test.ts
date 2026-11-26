/**
 * Plan-first mechanism + for-each path resolution tests.
 *
 * Covers:
 *   A. For-each sub-tasks with {workspace} output → frameworkRoot (NOT .dqa/)
 *   B. For-each sub-tasks with relative output    → projectDir (inside .dqa/)
 *   C. For-each source resolved with {change-id} state export
 *   D. Agent-task `when` in for-each: skip when marker absent, run when present
 *   E. Gate `when`: auto-skip when plan.md absent, fire for approval when present
 *
 * These tests lock the invariant that source code goes to {workspace} (outside
 * .dqa/) while DQA deliverables go to relative paths (inside .dqa/projects/<p>/).
 */

import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import type { WorkflowV3 } from './schema-types-v3.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-pf-'))
  await fs.mkdirp(path.join(tmpDir, '.dqa', 'projects', 'p'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

const projectDir = () => path.join(tmpDir, '.dqa', 'projects', 'p')

function orch(wf: WorkflowV3, run?: string): Orchestrator {
  return new Orchestrator(tmpDir, 'p', wf, run)
}

// ── A. For-each: {workspace} sub-task output → frameworkRoot, NOT .dqa/ ─────

describe('for-each sub-task {workspace} output resolves to frameworkRoot', () => {
  async function makeWorkflow(): Promise<WorkflowV3> {
    // Create a story file for the for-each to expand
    const storyPath = path.join(projectDir(), 'spec', 'stories', 'story-001.md')
    await fs.mkdirp(path.dirname(storyPath))
    await fs.writeFile(storyPath, '# Story 001\n\nScenario: basic flow\n')

    return {
      name: 'dev-test', version: 1,
      pipeline: [{ phase: 'implement' }],
      phases: {
        implement: {
          tasks: [{
            id: 'implement',
            type: 'for-each',
            source: 'spec/stories/story-*.md',
            as: 'story',
            'sub-tasks': [{
              id: 'backend',
              type: 'agent-task',
              output: '{workspace}/src/{story.id}/**/*',
              instruction: 'write backend',
            }],
          }],
        },
      },
    }
  }

  it('done() succeeds when code file exists at frameworkRoot/src/story-001/', async () => {
    const wf = await makeWorkflow()
    const o = orch(wf)
    await o.start()

    // Write the code file at workspace root (correct location — OUTSIDE .dqa/)
    const codeFile = path.join(tmpDir, 'src', 'story-001', 'handler.ts')
    await fs.mkdirp(path.dirname(codeFile))
    await fs.writeFile(codeFile, 'export {}')

    await expect(o.done('implement:story-001:backend')).resolves.toBeDefined()
  })

  it('done() throws when code file is inside .dqa/projects/ (wrong location)', async () => {
    const wf = await makeWorkflow()
    const o = orch(wf)
    await o.start()

    // Place the file inside .dqa/ — this is the bug being guarded against
    const wrongFile = path.join(projectDir(), 'src', 'story-001', 'handler.ts')
    await fs.mkdirp(path.dirname(wrongFile))
    await fs.writeFile(wrongFile, 'export {}')

    await expect(o.done('implement:story-001:backend')).rejects.toThrow()
  })

  it('next() output field in payload is an absolute path starting with frameworkRoot', async () => {
    const wf = await makeWorkflow()
    const o = orch(wf)
    const r = await o.start()

    expect(r.status).toBe('next')
    if (r.status !== 'next') return

    // Output should resolve to absolute path under tmpDir, not .dqa/
    expect(path.isAbsolute(r.output)).toBe(true)
    expect(r.output.startsWith(tmpDir)).toBe(true)
    expect(r.output).not.toContain('.dqa')
  })
})

// ── B. For-each: relative sub-task output → projectDir (inside .dqa/) ────────

describe('for-each sub-task relative output resolves inside projectDir', () => {
  async function makeWorkflow(): Promise<WorkflowV3> {
    const storyPath = path.join(projectDir(), 'spec', 'stories', 'story-001.md')
    await fs.mkdirp(path.dirname(storyPath))
    await fs.writeFile(storyPath, '# Story 001\nScenario: plan it\n')

    return {
      name: 'plan-test', version: 1,
      pipeline: [{ phase: 'plan' }],
      phases: {
        plan: {
          tasks: [{
            id: 'implement',
            type: 'for-each',
            source: 'spec/stories/story-*.md',
            as: 'story',
            'sub-tasks': [{
              id: 'story-plan',
              type: 'agent-task',
              output: 'plan/{story.id}/plan.md',
              instruction: 'write plan',
            }],
          }],
        },
      },
    }
  }

  it('done() succeeds when plan.md exists inside projectDir', async () => {
    const wf = await makeWorkflow()
    const o = orch(wf)
    await o.start()

    // DQA deliverable → inside .dqa/projects/p/
    const planFile = path.join(projectDir(), 'plan', 'story-001', 'plan.md')
    await fs.mkdirp(path.dirname(planFile))
    await fs.writeFile(planFile, '# Plan')

    await expect(o.done('implement:story-001:story-plan')).resolves.toBeDefined()
  })

  it('done() throws when plan.md is at frameworkRoot instead of projectDir', async () => {
    const wf = await makeWorkflow()
    const o = orch(wf)
    await o.start()

    // Wrong location: workspace root instead of .dqa/projects/p/
    const wrongFile = path.join(tmpDir, 'plan', 'story-001', 'plan.md')
    await fs.mkdirp(path.dirname(wrongFile))
    await fs.writeFile(wrongFile, '# Plan')

    await expect(o.done('implement:story-001:story-plan')).rejects.toThrow('Output file not found')
  })
})

// ── C. For-each source resolved with {change-id} state export ────────────────

describe('for-each source interpolates {change-id} from state exports', () => {
  it('expands stories under changes/{change-id}/stories/ when export is set', async () => {
    // Create delta story file for change ch-001
    const storyPath = path.join(projectDir(), 'changes', 'ch-001', 'stories', 'story-001.md')
    await fs.mkdirp(path.dirname(storyPath))
    await fs.writeFile(storyPath, '# Delta story\n')

    const wf: WorkflowV3 = {
      name: 'delta-test', version: 1,
      pipeline: [{ phase: 'implement-delta' }],
      phases: {
        'implement-delta': {
          tasks: [{
            id: 'delta-implement',
            type: 'for-each',
            source: 'changes/{change-id}/stories/story-*.md',
            as: 'story',
            'sub-tasks': [{
              id: 'backend',
              type: 'agent-task',
              output: '{workspace}/src/{story.id}/**/*',
              instruction: 'implement delta',
            }],
          }],
        },
      },
    }

    const o = orch(wf)
    // Pass change-id as a start export so it's in state
    await o.start({ exports: { 'change-id': 'ch-001' } })

    // Should have expanded to the story under changes/ch-001/
    const codeFile = path.join(tmpDir, 'src', 'story-001', 'app.ts')
    await fs.mkdirp(path.dirname(codeFile))
    await fs.writeFile(codeFile, 'export {}')

    // If source was NOT resolved, no expansion happens → done() would throw
    await expect(o.done('delta-implement:story-001:backend')).resolves.toBeDefined()
  })

  it('for-each with no matching source blocks (_for-each-empty), then done() clears it', async () => {
    const wf: WorkflowV3 = {
      name: 'delta-empty', version: 1,
      pipeline: [{ phase: 'implement-delta' }],
      phases: {
        'implement-delta': {
          tasks: [{
            id: 'delta-implement',
            type: 'for-each',
            source: 'changes/{change-id}/stories/story-*.md',
            as: 'story',
            'sub-tasks': [{
              id: 'backend',
              type: 'agent-task',
              output: '{workspace}/src/{story.id}/**/*',
              instruction: 'implement',
            }],
          }],
        },
      },
    }

    const o = orch(wf)
    // change-id points to a dir with no stories.
    const r = await o.start({ exports: { 'change-id': 'ch-empty' } })

    // A for-each whose source matches 0 items is NOT auto-completed: the
    // producing step may still emit those files on a later next(), so the
    // orchestrator surfaces `blocked` (gate _for-each-empty) rather than a
    // false `complete`. A genuinely-empty for-each is cleared by marking it
    // done explicitly.
    expect(r.status).toBe('blocked')
    expect((r as { gate: string }).gate).toBe('_for-each-empty')

    // Acknowledge the empty for-each → the workflow completes.
    const after = await o.done('delta-implement')
    expect(after.status).toBe('complete')
  })
})

// ── D. Agent-task `when` in for-each: skip vs run based on file ──────────────

describe('for-each agent-task when: auto-skips when marker absent', () => {
  async function makeStory(): Promise<void> {
    const storyPath = path.join(projectDir(), 'spec', 'stories', 'story-001.md')
    await fs.mkdirp(path.dirname(storyPath))
    await fs.writeFile(storyPath, '# Story 001\n')
  }

  const planFirstWorkflow: WorkflowV3 = {
    name: 'plan-first', version: 1,
    pipeline: [{ phase: 'implement' }],
    phases: {
      implement: {
        tasks: [{
          id: 'implement',
          type: 'for-each',
          source: 'spec/stories/story-*.md',
          as: 'story',
          'sub-tasks': [
            {
              id: 'story-plan',
              type: 'agent-task',
              when: 'file-exists(plan/{story.id}/needs-plan.marker)',
              output: 'plan/{story.id}/plan.md',
              instruction: 'write plan',
            },
            {
              id: 'backend',
              type: 'agent-task',
              output: '{workspace}/src/{story.id}/**/*',
              depends: ['story-plan'],
              instruction: 'write backend',
            },
          ],
        }],
      },
    },
  }

  it('story-plan is skipped when needs-plan.marker is absent', async () => {
    await makeStory()
    const o = orch(planFirstWorkflow)
    await o.start()

    // No marker → story-plan should be skipped, backend should be the next task
    const r = await o.next()
    expect(r.status).toBe('next')
    if (r.status !== 'next') return
    // story-plan is skipped; backend (which depends on story-plan) should be next
    expect(r.task).toBe('implement:story-001:backend')
  })

  it('story-plan runs when needs-plan.marker is present', async () => {
    await makeStory()

    // Write the marker so the when condition evaluates true
    const markerPath = path.join(projectDir(), 'plan', 'story-001', 'needs-plan.marker')
    await fs.mkdirp(path.dirname(markerPath))
    await fs.writeFile(markerPath, 'item-count: 10\n')

    const o = orch(planFirstWorkflow)
    await o.start()

    const r = await o.next()
    expect(r.status).toBe('next')
    if (r.status !== 'next') return
    expect(r.task).toBe('implement:story-001:story-plan')
  })
})

// ── E. Gate `when`: auto-skip vs approval based on plan.md ───────────────────

describe('gate when: auto-skips when plan.md absent, waits for approval when present', () => {
  async function makeStory(): Promise<void> {
    const storyPath = path.join(projectDir(), 'spec', 'stories', 'story-001.md')
    await fs.mkdirp(path.dirname(storyPath))
    await fs.writeFile(storyPath, '# Story 001\n')
  }

  const planGateWorkflow: WorkflowV3 = {
    name: 'plan-gate', version: 1,
    pipeline: [{ phase: 'implement' }],
    phases: {
      implement: {
        tasks: [{
          id: 'implement',
          type: 'for-each',
          source: 'spec/stories/story-*.md',
          as: 'story',
          'sub-tasks': [
            {
              id: 'story-plan',
              type: 'agent-task',
              when: 'file-exists(plan/{story.id}/needs-plan.marker)',
              output: 'plan/{story.id}/plan.md',
              instruction: 'write plan',
            },
            {
              id: 'plan-gate',
              type: 'gate',
              'gate-type': 'approval',
              depends: ['story-plan'],
              when: 'file-exists(plan/{story.id}/plan.md)',
              description: 'Review plan before coding',
            },
            {
              id: 'backend',
              type: 'agent-task',
              output: '{workspace}/src/{story.id}/**/*',
              depends: ['plan-gate'],
              instruction: 'write backend',
            },
          ],
        }],
      },
    },
  }

  it('gate is skipped and backend runs immediately when no plan.md', async () => {
    await makeStory()
    const o = orch(planGateWorkflow)
    await o.start()

    // No marker → story-plan skipped → no plan.md → plan-gate skipped → backend next
    const r = await o.next()
    expect(r.status).toBe('next')
    if (r.status !== 'next') return
    expect(r.task).toBe('implement:story-001:backend')
  })

  it('gate fires for approval when plan.md exists', async () => {
    await makeStory()

    // Write both marker and plan.md to simulate a large story that was planned
    const markerPath = path.join(projectDir(), 'plan', 'story-001', 'needs-plan.marker')
    await fs.mkdirp(path.dirname(markerPath))
    await fs.writeFile(markerPath, 'item-count: 12\n')

    const planPath = path.join(projectDir(), 'plan', 'story-001', 'plan.md')
    await fs.writeFile(planPath, '# Plan\n## Steps\n- [ ] Step 1\n')

    const o = orch(planGateWorkflow)
    await o.start()

    // story-plan done (already has output plan.md)
    await o.done('implement:story-001:story-plan')

    // Now plan-gate should be waiting for approval
    const r = await o.next()
    expect(r.status).toBe('waiting')
    if (r.status !== 'waiting') return
    expect(r.gate).toBe('implement:story-001:plan-gate')
  })

  it('backend runs after plan-gate is approved', async () => {
    await makeStory()

    const markerPath = path.join(projectDir(), 'plan', 'story-001', 'needs-plan.marker')
    await fs.mkdirp(path.dirname(markerPath))
    await fs.writeFile(markerPath, 'item-count: 12\n')

    const planPath = path.join(projectDir(), 'plan', 'story-001', 'plan.md')
    await fs.writeFile(planPath, '# Plan\n## Steps\n- [ ] Step 1\n')

    const o = orch(planGateWorkflow)
    await o.start()
    await o.done('implement:story-001:story-plan')
    await o.approve('implement:story-001:plan-gate')

    const r = await o.next()
    expect(r.status).toBe('next')
    if (r.status !== 'next') return
    expect(r.task).toBe('implement:story-001:backend')
  })
})

// ── F. Item vars resolved in file-based task instructions ────────────────────

describe('for-each item vars ({story.id}, {story.path}) resolved in instruction', () => {
  it('next() payload instruction contains resolved story.id', async () => {
    const storyPath = path.join(projectDir(), 'spec', 'stories', 'story-001.md')
    await fs.mkdirp(path.dirname(storyPath))
    await fs.writeFile(storyPath, '# Story 001\n')

    const wf: WorkflowV3 = {
      name: 'inline-vars', version: 1,
      pipeline: [{ phase: 'impl' }],
      phases: {
        impl: {
          tasks: [{
            id: 'implement',
            type: 'for-each',
            source: 'spec/stories/story-*.md',
            as: 'story',
            'sub-tasks': [{
              id: 'backend',
              type: 'agent-task',
              output: '{workspace}/src/{story.id}/**/*',
              // Inline instruction with item vars
              instruction: 'Implement story {story.id} using file {story.path}',
            }],
          }],
        },
      },
    }

    const o = orch(wf)
    const r = await o.start()

    expect(r.status).toBe('next')
    if (r.status !== 'next') return
    // Item vars must be substituted — no raw placeholders remaining
    expect(r.instruction).toContain('story-001')
    expect(r.instruction).not.toContain('{story.id}')
    expect(r.instruction).not.toContain('{story.path}')
  })
})

describe('for-each item var {story.dir} resolves to the source folder', () => {
  it('output written beside a foldered source resolves into that folder', async () => {
    // Story foldered by bounded context: spec/stories/<context>/STORY-NNN.md
    const storyPath = path.join(projectDir(), 'spec', 'stories', 'payment', 'STORY-001.md')
    await fs.mkdirp(path.dirname(storyPath))
    await fs.writeFile(storyPath, '# Story 001\n')

    const wf: WorkflowV3 = {
      name: 'dir-var', version: 1,
      pipeline: [{ phase: 'impl' }],
      phases: {
        impl: {
          tasks: [{
            id: 'implement',
            type: 'for-each',
            source: 'spec/stories/**/STORY-*.md',
            as: 'story',
            'sub-tasks': [{
              id: 'notes',
              type: 'agent-task',
              // {story.dir} must resolve to spec/stories/payment so the note
              // lands beside the story, not in a flat spec/stories/.
              output: '{story.dir}/{story.id}.notes.md',
              instruction: 'write notes for {story.id} in {story.dir}',
            }],
          }],
        },
      },
    }

    const o = orch(wf)
    const r = await o.start()
    expect(r.status).toBe('next')
    if (r.status !== 'next') return
    expect(r.output).toBe('spec/stories/payment/STORY-001.notes.md')
    expect(r.instruction).toContain('spec/stories/payment')

    // done() resolves {story.dir} the same way for its existence check.
    await fs.writeFile(path.join(projectDir(), 'spec', 'stories', 'payment', 'STORY-001.notes.md'), 'notes\n')
    await expect(o.done('implement:STORY-001:notes')).resolves.toBeDefined()
  })
})
