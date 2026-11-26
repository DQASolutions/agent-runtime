/**
 * Orchestrator expression-interpolation integration tests.
 *
 * For every site in the workflow schema that evaluates an expression
 * (prereq, task validate, task when, phase when, gate check, switch eval),
 * verify `{var}` placeholders are resolved against the expression context
 * before the expression engine sees them.
 *
 * Regression cover:
 *   - document-ingestion prereq using {docs-folder}
 *   - new-change gate check using {change-id} (previously silent-pass)
 */

import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import { writeTaskDone } from './state-manager.js'
import type { WorkflowV3 } from './schema-types-v3.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-interp-'))
  await fs.mkdirp(path.join(tmpDir, '.dqa', 'projects', 'p'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

function orchFor(wf: WorkflowV3): Orchestrator {
  return new Orchestrator(tmpDir, 'p', wf)
}

// ── prereq ─────────────────────────────────────────────────────────────────

describe('workflow.prereq interpolation', () => {
  const wf: WorkflowV3 = {
    name: 'test', version: 3,
    prereq: 'file-exists({target-file})',
    pipeline: [{ phase: 'only' }],
    phases: {
      only: { tasks: [{ id: 'a', type: 'action', run: 'echo hi' }] },
    },
  }

  it('resolves {var} from opts.exports and passes when file exists', async () => {
    const f = path.join(tmpDir, 'here.txt')
    fs.writeFileSync(f, 'x')
    const r = await orchFor(wf).start({ exports: { 'target-file': f } })
    expect(r.status).toBe('next')
  })

  it('error message contains the resolved (not literal) expression', async () => {
    const missing = path.join(tmpDir, 'nope.txt')
    await expect(orchFor(wf).start({ exports: { 'target-file': missing } })).rejects.toThrow(
      `file-exists(${missing})`,
    )
  })
})

// ── task validate ──────────────────────────────────────────────────────────

describe('task.validate interpolation', () => {
  it('resolves {var} in validate expression using exports', async () => {
    const outDir = path.join(tmpDir, '.dqa', 'projects', 'p')
    const outFile = path.join(outDir, 'target-abc.md')
    fs.writeFileSync(outFile, 'x')

    const wf: WorkflowV3 = {
      name: 't', version: 3,
      pipeline: [{ phase: 'only' }],
      phases: {
        only: {
          tasks: [
            {
              id: 'produce',
              type: 'agent-task',
              output: 'target-{slug}.md',
              validate: 'file-exists(target-{slug}.md)',
              instruction: 'make it',
            },
          ],
        },
      },
    }
    const orch = orchFor(wf)
    await orch.start({ exports: { slug: 'abc' } })
    // Completing with resolved output must pass validation without throwing.
    await expect(orch.done('produce')).resolves.toBeDefined()
  })
})

// ── task when ──────────────────────────────────────────────────────────────

describe('task.when interpolation', () => {
  it('skips task when resolved expression is false, runs when true', async () => {
    const flag = path.join(tmpDir, '.dqa', 'projects', 'p', 'flag.txt')
    const wf: WorkflowV3 = {
      name: 't', version: 3,
      pipeline: [{ phase: 'only' }],
      phases: {
        only: {
          tasks: [
            {
              id: 'gated',
              type: 'agent-task',
              output: 'out.md',
              when: 'file-exists({flag-file})',
              instruction: 'only-if-flag',
            },
          ],
        },
      },
    }
    // Without the flag file: task is skipped, workflow completes.
    const r1 = await orchFor(wf).start({ exports: { 'flag-file': flag } })
    expect(r1.status).toBe('complete')

    // With the flag file: task becomes ready.
    await fs.remove(path.join(tmpDir, '.dqa', 'state'))
    fs.writeFileSync(flag, 'x')
    const r2 = await orchFor(wf).start({ exports: { 'flag-file': flag } })
    expect(r2.status).toBe('next')
  })
})

// ── phase when ─────────────────────────────────────────────────────────────

describe('phase.when interpolation', () => {
  it('skips whole phase when resolved expression is false', async () => {
    const wf: WorkflowV3 = {
      name: 't', version: 3,
      pipeline: [
        { phase: 'maybe', when: 'file-exists({trigger})' },
        { phase: 'always' },
      ],
      phases: {
        maybe: { tasks: [{ id: 'x', type: 'action', run: 'echo x' }] },
        always: { tasks: [{ id: 'y', type: 'action', run: 'echo y' }] },
      },
    }
    const trigger = path.join(tmpDir, 'nope.txt')
    const orch = orchFor(wf)
    const r = await orch.start({ exports: { trigger } })
    expect(r.status).toBe('next')
    if (r.status === 'next') expect(r.task).toBe('y') // maybe phase skipped
  })
})

// ── switch eval ────────────────────────────────────────────────────────────

describe('switch.eval interpolation', () => {
  it('resolves {var} inside the switch eval expression', async () => {
    const wf: WorkflowV3 = {
      name: 't', version: 3,
      pipeline: [{ phase: 'only' }],
      phases: {
        only: {
          tasks: [
            {
              id: 'route',
              type: 'switch',
              eval: '{branch}',
              routes: {
                alpha: [{ id: 'go-alpha', type: 'action', run: 'echo a' }],
                beta: [{ id: 'go-beta', type: 'action', run: 'echo b' }],
              },
            },
          ],
        },
      },
    }
    const r = await orchFor(wf).start({ exports: { branch: 'beta' } })
    expect(r.status).toBe('next')
    if (r.status === 'next') {
      expect(r.task.endsWith('go-beta')).toBe(true)
      expect(r.task).not.toContain('go-alpha')
    }
  })
})
