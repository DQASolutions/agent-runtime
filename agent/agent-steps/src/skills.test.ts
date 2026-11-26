import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import type { WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'
import { loadSkills } from './skills.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-')) })
afterEach(async () => { await fs.remove(dir) })

describe('loadSkills', () => {
  it('attaches app/skills/<task-id>.md as each task instruction', async () => {
    await fs.writeFile(path.join(dir, 'screen.md'), '# Skill: screen\n\nEvaluate the KYC rules over the case.')
    const wf = {
      name: 'w', version: 3, pipeline: [{ phase: 'p' }],
      phases: { p: { tasks: [
        { id: 'map', type: 'agent-task', uses: 'ingest', depends: [] },
        { id: 'screen', type: 'agent-task', uses: 'evaluate-rules', depends: ['map'] },
      ] } },
    } as unknown as WorkflowV3

    await loadSkills(wf, dir)

    const tasks = (wf.phases as Record<string, { tasks: Array<Record<string, unknown>> }>).p.tasks
    expect(tasks.find((t) => t.id === 'screen')!.instruction).toContain('Evaluate the KYC rules')
    expect(tasks.find((t) => t.id === 'map')!.instruction).toBeUndefined() // no skill file → untouched
  })
})
