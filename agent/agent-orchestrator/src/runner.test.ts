import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import { Orchestrator } from './orchestrator.js'
import { WorkflowRunner, type ExecutorRegistry } from './runner.js'
import type { WorkflowV3 } from './schema-types-v3.js'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-runner-'))
  await fs.mkdirp(path.join(tmp, '.dqa', 'projects', 'demo'))
})
afterEach(async () => {
  await fs.remove(tmp)
})

// A workflow whose steps are executed by the ENGINE via registered executors.
const wf: WorkflowV3 = {
  name: 'auto',
  version: 3,
  pipeline: [{ phase: 'p' }],
  phases: {
    p: {
      tasks: [
        { id: 'screen', type: 'agent-task', uses: 'screen-exec', outputs: { flagged: { type: 'boolean' }, count: { type: 'number' } }, depends: [] },
        { id: 'signoff', type: 'gate', 'gate-type': 'approval', description: 'approve flagged case', depends: ['screen'], when: 'screen.flagged == true' },
        { id: 'decide', type: 'agent-task', uses: 'decide-exec', depends: ['screen'] },
      ],
    },
  },
} as unknown as WorkflowV3

describe('WorkflowRunner — engine drives executor-backed steps', () => {
  it('runs executors, branches to the gate on a structured output, completes after approval', async () => {
    const ran: string[] = []
    const executors: ExecutorRegistry = {
      'screen-exec': { run: async () => { ran.push('screen'); return { exports: { flagged: true, count: 3 } } } },
      'decide-exec': { run: async (ctx) => { ran.push('decide'); return { exports: { reportedCount: ctx.task.task } } } },
    }
    const gates: string[] = []
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', wf), executors)
    const res = await runner.run({ onGate: (g) => { gates.push(g); return true } })

    expect(res.status).toBe('complete')
    expect(ran).toEqual(['screen', 'decide']) // engine drove both steps
    expect(gates).toEqual(['signoff']) // the gate surfaced (flagged == true)
  })

  it('skips the gate when the structured output makes when: false', async () => {
    const executors: ExecutorRegistry = {
      'screen-exec': { run: async () => ({ exports: { flagged: false, count: 0 } }) },
      'decide-exec': { run: async () => ({}) },
    }
    const gates: string[] = []
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', wf), executors)
    const res = await runner.run({ onGate: (g) => { gates.push(g); return true } })

    expect(res.status).toBe('complete')
    expect(gates).toEqual([]) // gate skipped — when: screen.flagged == true was false
  })

  it('stops at the gate when onGate is not provided (returns waiting)', async () => {
    const executors: ExecutorRegistry = {
      'screen-exec': { run: async () => ({ exports: { flagged: true, count: 1 } }) },
      'decide-exec': { run: async () => ({}) },
    }
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', wf), executors)
    const res = await runner.run()
    expect(res.status).toBe('waiting')
    expect(res.status === 'waiting' && res.gate).toBe('signoff')
  })

  it('throws if a step uses an unregistered executor', async () => {
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', wf), {})
    await expect(runner.run({ onGate: () => true })).rejects.toThrow(/no StepExecutor registered/)
  })

  it('threads the app-level profile default into every StepContext', async () => {
    const seen: Array<string | undefined> = []
    const executors: ExecutorRegistry = {
      'screen-exec': { run: async (ctx) => { seen.push(ctx.profile); return { exports: { flagged: false, count: 0 } } } },
      'decide-exec': { run: async (ctx) => { seen.push(ctx.profile); return {} } },
    }
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', wf), executors, { profile: 'tt133' })
    const res = await runner.run({ onGate: () => true })

    expect(res.status).toBe('complete')
    expect(seen).toEqual(['tt133', 'tt133']) // app default reaches both steps
  })

  it('leaves StepContext.profile undefined when no app default is given', async () => {
    let seen: string | undefined = 'unset'
    const executors: ExecutorRegistry = {
      'screen-exec': { run: async (ctx) => { seen = ctx.profile; return { exports: { flagged: false, count: 0 } } } },
      'decide-exec': { run: async () => ({}) },
    }
    const runner = new WorkflowRunner(new Orchestrator(tmp, 'demo', wf), executors)
    await runner.run({ onGate: () => true })
    expect(seen).toBeUndefined()
  })
})
