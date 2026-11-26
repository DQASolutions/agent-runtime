import fs from 'fs-extra'
import path from 'node:path'
import type { WorkflowV3 } from '@dqa-ai-solutions/agent-orchestrator'

/**
 * Attach an app's per-step SKILLS to its workflow. A skill is the step's
 * instruction file — `<skillsDir>/<task-id>.md` (the same notion DQA uses, where
 * every step is a skill). The content is set as the task's inline `instruction`
 * so the engine's existing resolution (override → inline → remote) and the
 * next-task payload carry it. Deterministic `uses:` steps get a skill as
 * documentation; agent steps get it as their actual brief.
 *
 * Mutates + returns the workflow. Missing skill files are simply skipped.
 */
export async function loadSkills(workflow: WorkflowV3, skillsDir: string): Promise<WorkflowV3> {
  const phases = workflow.phases as Record<string, { tasks?: Array<Record<string, unknown>> }>
  for (const phase of Object.values(phases)) {
    for (const task of phase.tasks ?? []) {
      const id = task.id as string | undefined
      if (!id) continue
      const skillPath = path.join(skillsDir, `${id}.md`)
      if (await fs.pathExists(skillPath)) {
        task.instruction = await fs.readFile(skillPath, 'utf-8')
      }
    }
  }
  return workflow
}
