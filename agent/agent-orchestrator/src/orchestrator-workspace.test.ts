/**
 * Orchestrator {workspace} and {project-dir} variable resolution tests.
 *
 * Contract:
 *   - {workspace}    → frameworkRoot (workspace root, parent of .dqa/)
 *   - {project-dir}  → frameworkRoot/.dqa/projects/<project> (absolute)
 *
 * This is the code/test separation invariant:
 *   - Documents produced by DQA → under {project-dir} (inside .dqa/)
 *   - Code + test code          → under {workspace}   (project tree, NOT inside .dqa/)
 *
 * Tests verify that:
 *   1. Agent-task with output "{workspace}/src/story.md" resolves to frameworkRoot,
 *      not projectDir — done() checks the file at the workspace path.
 *   2. Glob output "{workspace}/src/**\/*" matches files at workspace path.
 *   3. Action task `run` with {project-dir} resolves to the absolute projectDir.
 *   4. A doc output without {workspace} (e.g. "spec/domain.md") resolves inside projectDir.
 */

import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import type { WorkflowV3 } from './schema-types-v3.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-ws-'))
  await fs.mkdirp(path.join(tmpDir, '.dqa', 'projects', 'p'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

function orchFor(wf: WorkflowV3): Orchestrator {
  return new Orchestrator(tmpDir, 'p', wf)
}

// ── Helpers ────────────────────────────────────────────────────────────────

const projectDir = () => path.join(tmpDir, '.dqa', 'projects', 'p')

// ── 1. {workspace} in agent-task output → resolves to frameworkRoot ────────

describe('{workspace} output resolves to frameworkRoot, not projectDir', () => {
  const wf: WorkflowV3 = {
    name: 'ws-test', version: 3,
    pipeline: [{ phase: 'impl' }],
    phases: {
      impl: {
        tasks: [
          {
            id: 'write-code',
            type: 'agent-task',
            output: '{workspace}/src/app.ts',
            instruction: 'write the file',
          },
        ],
      },
    },
  }

  it('done() succeeds when file exists at frameworkRoot path', async () => {
    const targetPath = path.join(tmpDir, 'src', 'app.ts')
    await fs.mkdirp(path.dirname(targetPath))
    await fs.writeFile(targetPath, '// code')

    const orch = orchFor(wf)
    await orch.start()
    // done() should verify the file at {workspace}/src/app.ts = tmpDir/src/app.ts
    await expect(orch.done('write-code')).resolves.toBeDefined()
  })

  it('done() throws when file exists only at projectDir (wrong location)', async () => {
    // Place file inside .dqa/projects/p/src/app.ts instead of workspace root
    const wrongPath = path.join(projectDir(), 'src', 'app.ts')
    await fs.mkdirp(path.dirname(wrongPath))
    await fs.writeFile(wrongPath, '// code')

    const orch = orchFor(wf)
    await orch.start()
    await expect(orch.done('write-code')).rejects.toThrow()
  })

  it('done() throws when file is absent entirely', async () => {
    const orch = orchFor(wf)
    await orch.start()
    await expect(orch.done('write-code')).rejects.toThrow('Output file not found')
  })
})

// ── 2. {workspace} glob output matches files at workspace path ─────────────

describe('{workspace} glob output', () => {
  const wf: WorkflowV3 = {
    name: 'ws-glob', version: 3,
    pipeline: [{ phase: 'impl' }],
    phases: {
      impl: {
        tasks: [
          {
            id: 'write-tests',
            type: 'agent-task',
            output: '{workspace}/tests/**/*',
            'min-output-count': 1,
            instruction: 'write the test files',
          },
        ],
      },
    },
  }

  it('done() succeeds when matching files are produced during the run', async () => {
    const testFile = path.join(tmpDir, 'tests', 'unit', 'foo.test.ts')
    await fs.mkdirp(path.dirname(testFile))

    const orch = orchFor(wf)
    await orch.start()
    // The agent produces its output DURING the run — done()'s freshness guard
    // requires ≥1 file written since the run started (pre-existing files don't
    // count, so a task can't be marked done on stale artefacts).
    // Carry a valid DQA:covers tag so the schema lint passes (the referential
    // check against requirements.yaml is skipped when no inventory exists).
    await fs.writeFile(testFile, '/** DQA:covers=S001-AC-001 */\ndescribe("foo", () => {})\n')
    await expect(orch.done('write-tests')).resolves.toBeDefined()
  })

  it('done() throws when no matching files exist at workspace path', async () => {
    const orch = orchFor(wf)
    await orch.start()
    await expect(orch.done('write-tests')).rejects.toThrow()
  })
})

// ── 3. {project-dir} in action run command resolves to absolute projectDir ─

describe('{project-dir} in action run command', () => {
  const wf: WorkflowV3 = {
    name: 'pd-test', version: 3,
    pipeline: [{ phase: 'verify' }],
    phases: {
      verify: {
        tasks: [
          {
            id: 'run-validate',
            type: 'action',
            run: 'dqa code-validate --pack {project-dir}/build/pack',
            output: 'build/pack/verify-report.json',
          },
        ],
      },
    },
  }

  it('next() returns instruction with {project-dir} resolved to absolute path', async () => {
    const orch = orchFor(wf)
    const r = await orch.start()

    expect(r.status).toBe('next')
    if (r.status !== 'next') return

    // Instruction should contain the fully-resolved absolute path
    const expectedPath = path.join(projectDir(), 'build', 'pack')
    expect(r.instruction).toContain(expectedPath)

    // Must NOT contain the literal placeholder
    expect(r.instruction).not.toContain('{project-dir}')
  })
})

// ── 4. Doc output (no {workspace}) resolves inside projectDir ─────────────

describe('doc output without {workspace} resolves inside projectDir', () => {
  const wf: WorkflowV3 = {
    name: 'doc-test', version: 3,
    pipeline: [{ phase: 'spec' }],
    phases: {
      spec: {
        tasks: [
          {
            id: 'write-domain',
            type: 'agent-task',
            output: 'spec/domain.md',
            instruction: 'write the domain model',
          },
        ],
      },
    },
  }

  it('done() succeeds when file exists under projectDir/spec/domain.md', async () => {
    const docPath = path.join(projectDir(), 'spec', 'domain.md')
    await fs.mkdirp(path.dirname(docPath))
    await fs.writeFile(docPath, '# Domain')

    const orch = orchFor(wf)
    await orch.start()
    await expect(orch.done('write-domain')).resolves.toBeDefined()
  })

  it('done() throws when file is placed at frameworkRoot/spec/domain.md (wrong location)', async () => {
    // Placing the doc at workspace root instead of inside .dqa/projects/p/
    const wrongPath = path.join(tmpDir, 'spec', 'domain.md')
    await fs.mkdirp(path.dirname(wrongPath))
    await fs.writeFile(wrongPath, '# Domain')

    const orch = orchFor(wf)
    await orch.start()
    await expect(orch.done('write-domain')).rejects.toThrow('Output file not found')
  })
})
