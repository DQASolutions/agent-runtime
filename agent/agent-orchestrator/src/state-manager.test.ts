import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getStateDir,
  initRun,
  writeTaskDone,
  writeTaskSkipped,
  writeGateApproved,
  writePhaseSkipped,
  loadState,
  loadProjectExports,
} from './state-manager.js'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-state-'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

// ── getStateDir ────────────────────────────────────────────────────────────

describe('getStateDir', () => {
  it('uses project name as directory when no run specified', () => {
    const dir = getStateDir(tmpDir, 'my-project')
    expect(dir).toBe(path.join(tmpDir, '.dqa', 'state', 'my-project'))
  })

  it('uses project--run as directory when run is specified', () => {
    const dir = getStateDir(tmpDir, 'my-project', 'sub-billing')
    expect(dir).toBe(path.join(tmpDir, '.dqa', 'state', 'my-project--sub-billing'))
  })
})

// ── initRun ────────────────────────────────────────────────────────────────

describe('initRun', () => {
  it('creates _run.yaml with correct fields', async () => {
    const stateDir = getStateDir(tmpDir, 'payment')
    await initRun(stateDir, {
      project: 'payment',
      workflow: 'new-change',
      input: 'add subscription',
      startedBy: 'dev-a',
    })

    const runFile = path.join(stateDir, '_run.yaml')
    expect(await fs.pathExists(runFile)).toBe(true)

    const state = await loadState(stateDir)
    expect(state.run.project).toBe('payment')
    expect(state.run.workflow).toBe('new-change')
    expect(state.run.input).toBe('add subscription')
    expect(state.run.startedBy).toBe('dev-a')
    expect(state.run.started).toBeDefined()
  })

  it('creates nested state directory if not exists', async () => {
    const stateDir = getStateDir(tmpDir, 'new-project')
    await initRun(stateDir, { project: 'new-project', workflow: 'dqa' })
    expect(await fs.pathExists(stateDir)).toBe(true)
  })

  it('throws if _run.yaml already exists', async () => {
    const stateDir = getStateDir(tmpDir, 'dupe')
    await initRun(stateDir, { project: 'dupe', workflow: 'dqa' })
    await expect(
      initRun(stateDir, { project: 'dupe', workflow: 'dqa' }),
    ).rejects.toThrow(/already exists/)
  })
})

// ── writeTaskDone ──────────────────────────────────────────────────────────

describe('writeTaskDone', () => {
  it('creates <phase>/<task-id>.done.<by>.yaml when by is provided', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeTaskDone(stateDir, 'discover', 'domain', {
      output: 'projects/proj/domain.md',
      by: 'dev-a',
    })

    // Filename includes sanitized 'by' so two devs producing the same task
    // on parallel branches don't collide on the same file at git merge time.
    const doneFile = path.join(stateDir, 'discover', 'domain.done.dev-a.yaml')
    expect(await fs.pathExists(doneFile)).toBe(true)

    const state = await loadState(stateDir)
    expect(state.tasks['domain'].status).toBe('done')
    expect(state.tasks['domain'].output).toBe('projects/proj/domain.md')
    expect(state.tasks['domain'].by).toBe('dev-a')
  })

  it('falls back to legacy <task-id>.done.yaml when no by is provided', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeTaskDone(stateDir, 'discover', 'domain', {
      output: 'projects/proj/domain.md',
    })

    const doneFile = path.join(stateDir, 'discover', 'domain.done.yaml')
    expect(await fs.pathExists(doneFile)).toBe(true)
  })

  it('includes exports when provided', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeTaskDone(stateDir, 'scoping', 'change-brief', {
      output: 'change-brief.md',
      exports: { route: ['C1', 'C3'], 'permission-impact': false },
    })

    const state = await loadState(stateDir)
    expect(state.exports['route']).toEqual(['C1', 'C3'])
    expect(state.exports['permission-impact']).toBe(false)
  })

  it('sanitizes by for filename safety', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeTaskDone(stateDir, 'discover', 'domain', {
      output: 'domain.md',
      by: 'Alice O\'Brien <alice@example.com>',
    })

    // The 'by' field on the event content keeps the original value,
    // but the filename uses a sanitized form.
    const files = await fs.readdir(path.join(stateDir, 'discover'))
    const doneFile = files.find(f => f.startsWith('domain.done.') && f.endsWith('.yaml'))
    expect(doneFile).toBeDefined()
    expect(doneFile).toMatch(/^domain\.done\.[a-z0-9-]+\.yaml$/)

    const state = await loadState(stateDir)
    expect(state.tasks['domain'].by).toBe('Alice O\'Brien <alice@example.com>')
  })
})

// ── Per-dev merge semantics ────────────────────────────────────────────────

describe('loadState — per-dev merge (last-writer-wins)', () => {
  it('keeps the latest event when two devs completed the same task', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    // Simulate two devs both completing the same task on different branches.
    // After git merge, both files exist on disk.
    await writeTaskDone(stateDir, 'discover', 'domain', {
      output: 'domain.md',
      by: 'alice',
      exports: { route: ['A'] },
    })
    // Force a later timestamp for bob's event
    await new Promise(r => setTimeout(r, 5))
    await writeTaskDone(stateDir, 'discover', 'domain', {
      output: 'domain.md',
      by: 'bob',
      exports: { route: ['B'] },
    })

    // Both files should exist on disk
    const files = await fs.readdir(path.join(stateDir, 'discover'))
    expect(files).toContain('domain.done.alice.yaml')
    expect(files).toContain('domain.done.bob.yaml')

    // loadState picks the latest by 'at' timestamp
    const state = await loadState(stateDir)
    expect(state.tasks['domain'].by).toBe('bob')
    expect(state.exports['route']).toEqual(['B'])
  })

  it('reads legacy and per-dev files together, latest wins', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    // Legacy event (no 'by')
    await writeTaskDone(stateDir, 'discover', 'domain', {
      output: 'old.md',
    })
    await new Promise(r => setTimeout(r, 5))
    // Newer per-dev event
    await writeTaskDone(stateDir, 'discover', 'domain', {
      output: 'new.md',
      by: 'alice',
    })

    const state = await loadState(stateDir)
    expect(state.tasks['domain'].output).toBe('new.md')
    expect(state.tasks['domain'].by).toBe('alice')
  })

  it('keeps gate approvals from multiple devs, latest wins', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeGateApproved(stateDir, 'scoping', 'assumptions-gate', 'alice')
    await new Promise(r => setTimeout(r, 5))
    await writeGateApproved(stateDir, 'scoping', 'assumptions-gate', 'bob')

    const state = await loadState(stateDir)
    expect(state.gates['assumptions-gate'].by).toBe('bob')
  })
})

// ── writeTaskSkipped ───────────────────────────────────────────────────────

describe('writeTaskSkipped', () => {
  it('creates <phase>/<task-id>.skipped.yaml with reason', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeTaskSkipped(stateDir, 'permissions', 'perm-update', 'when: permission-impact == false')

    const state = await loadState(stateDir)
    expect(state.tasks['perm-update'].status).toBe('skipped')
    expect(state.tasks['perm-update'].reason).toBe('when: permission-impact == false')
  })
})

// ── writeGateApproved ──────────────────────────────────────────────────────

describe('writeGateApproved', () => {
  it('creates <phase>/<gate-id>.approved.yaml', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeGateApproved(stateDir, 'scoping', 'assumptions-gate', 'dev-a')

    const state = await loadState(stateDir)
    expect(state.gates['assumptions-gate'].status).toBe('passed')
    expect(state.gates['assumptions-gate'].by).toBe('dev-a')
  })
})

// ── writePhaseSkipped ──────────────────────────────────────────────────────

describe('writePhaseSkipped', () => {
  it('creates phase-level skipped file', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writePhaseSkipped(stateDir, 'security', 'when: compliance == none')

    const skipFile = path.join(stateDir, 'security.skipped.yaml')
    expect(await fs.pathExists(skipFile)).toBe(true)
  })
})

// ── loadState ──────────────────────────────────────────────────────────────

describe('loadState', () => {
  it('returns empty state from just _run.yaml', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    const state = await loadState(stateDir)
    expect(Object.keys(state.tasks)).toHaveLength(0)
    expect(Object.keys(state.gates)).toHaveLength(0)
    expect(Object.keys(state.exports)).toHaveLength(0)
  })

  it('accumulates exports from multiple done tasks', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeTaskDone(stateDir, 'scoping', 'task-a', {
      output: 'a.md',
      exports: { routeA: 'X' },
    })
    await writeTaskDone(stateDir, 'discover', 'task-b', {
      output: 'b.md',
      exports: { routeB: 'Y' },
    })

    const state = await loadState(stateDir)
    expect(state.exports['routeA']).toBe('X')
    expect(state.exports['routeB']).toBe('Y')
  })

  it('reconstructs full state from multiple phases', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })

    await writeTaskDone(stateDir, 'scoping', 'brief', { output: 'brief.md' })
    await writeGateApproved(stateDir, 'scoping', 'assumptions', 'dev-a')
    await writeTaskDone(stateDir, 'discover', 'domain', { output: 'domain.md' })
    await writeTaskSkipped(stateDir, 'security', 'audit', 'when: false')

    const state = await loadState(stateDir)
    expect(Object.keys(state.tasks)).toHaveLength(3) // brief, domain, audit
    expect(state.tasks['brief'].status).toBe('done')
    expect(state.tasks['domain'].status).toBe('done')
    expect(state.tasks['audit'].status).toBe('skipped')
    expect(state.gates['assumptions'].status).toBe('passed')
  })

  it('throws when no _run.yaml found', async () => {
    const stateDir = path.join(tmpDir, 'nonexistent')
    await expect(loadState(stateDir)).rejects.toThrow(/_run\.yaml/)
  })
})

// ── loadProjectExports ─────────────────────────────────────────────────────

describe('loadProjectExports', () => {
  it('returns empty object when no state dir exists', async () => {
    const exports = await loadProjectExports(tmpDir, 'nonexistent')
    expect(exports).toEqual({})
  })

  it('aggregates exports from a single bare state dir', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })
    await writeTaskDone(stateDir, 'phase1', 'taskA', {
      output: 'a.md',
      exports: { 'taskA.status': 'PASS', 'taskA.count': 3 },
    })
    const exports = await loadProjectExports(tmpDir, 'proj')
    expect(exports['taskA.status']).toBe('PASS')
    expect(exports['taskA.count']).toBe(3)
  })

  it('aggregates exports across multiple <project>--<run> dirs (composite mode)', async () => {
    const baDir = getStateDir(tmpDir, 'proj', 'ba')
    const archDir = getStateDir(tmpDir, 'proj', 'architect')
    await initRun(baDir, { project: 'proj', run: 'ba', workflow: 'dqa-ba' })
    await initRun(archDir, { project: 'proj', run: 'architect', workflow: 'dqa-architect' })

    await writeTaskDone(baDir, 'spec', 'convergence', {
      output: '',
      exports: { 'convergence.status': 'PASS' },
    })
    await writeTaskDone(archDir, 'design', 'cross-view-check', {
      output: '',
      exports: { 'cross_view_check.status': 'PASS' },
    })

    const exports = await loadProjectExports(tmpDir, 'proj')
    expect(exports['convergence.status']).toBe('PASS')
    expect(exports['cross_view_check.status']).toBe('PASS')
  })

  it('last-writer-wins on shared export keys across events', async () => {
    const stateDir = getStateDir(tmpDir, 'proj')
    await initRun(stateDir, { project: 'proj', workflow: 'dqa' })
    // Two events with the same export key; the later `at` should win.
    await writeTaskDone(stateDir, 'phase', 'task1', {
      output: '',
      exports: { 'shared.status': 'FAIL' },
    })
    // small delay then re-write with PASS
    await new Promise(r => setTimeout(r, 5))
    await writeTaskDone(stateDir, 'phase', 'task1', {
      output: '',
      exports: { 'shared.status': 'PASS' },
    })
    const exports = await loadProjectExports(tmpDir, 'proj')
    expect(exports['shared.status']).toBe('PASS')
  })

  it('ignores dirs not matching <project> or <project>--*', async () => {
    const stateRoot = path.join(tmpDir, '.dqa', 'state')
    await fs.ensureDir(stateRoot)
    // Sibling project should not contribute.
    const otherDir = getStateDir(tmpDir, 'other-proj')
    await initRun(otherDir, { project: 'other-proj', workflow: 'dqa' })
    await writeTaskDone(otherDir, 'phase', 'task', {
      output: '',
      exports: { 'other_task.status': 'PASS' },
    })
    // Substring-match guard: 'projX' must not match 'proj'.
    const exports = await loadProjectExports(tmpDir, 'proj')
    expect(exports['other_task.status']).toBeUndefined()
  })
})

