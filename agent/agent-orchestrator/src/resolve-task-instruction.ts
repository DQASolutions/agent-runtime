import fs from 'fs-extra'
import path from 'node:path'
import {
  isRemoteContentMode as defaultIsRemoteContentMode,
  fetchTaskInstruction as defaultFetchTaskInstruction,
} from './content-server-loader.js'

/**
 * Injectable dependencies — tests provide fakes to exercise the real
 * resolution code without monkey-patching module exports.
 */
export interface ResolveTaskInstructionDeps {
  isRemoteContentMode: () => boolean
  fetchTaskInstruction: (workflowName: string, taskId: string) => Promise<string>
}

const defaultDeps: ResolveTaskInstructionDeps = {
  isRemoteContentMode: defaultIsRemoteContentMode,
  fetchTaskInstruction: defaultFetchTaskInstruction,
}

/**
 * Resolve a task instruction.
 *
 * Precedence:
 *   1. Project override  (.dqa/overrides/<wf>/tasks/<id>.md)
 *      tried for each workflow name in the fallback chain
 *   2. Local task pool  (.dqa/tasks/<pool>/<id>.md)
 *      tried for each workflow name in the fallback chain — this is what makes
 *      local content mode actually work offline
 *   3. Inline schema field
 *   4. Remote render endpoint  (POST /v1/render-task)
 *      tried for each workflow name in the fallback chain
 *
 * The fallback chain is `[workflowName, ...fallbackWorkflows]`. The
 * fallback list is supplied by the caller (orchestrator) from the
 * workflow YAML's `task-instructions-from` field. Role-scoped workflows
 * use this to inherit instruction files from a shared role pool — e.g.
 * `dqa-ba` workflow with `task-instructions-from: ba` resolves
 * `tasks/dqa-ba/<id>.md` first, then `tasks/ba/<id>.md`.
 *
 * Content comes from the local pool in local mode, or from the DQA content
 * server in remote mode.
 *
 * Returns undefined ONLY when none of the sources are configured (no
 * override, no inline, remote mode off). A remote-mode fetch that fails
 * for ALL workflows in the chain throws — callers must surface the
 * error so the user knows why a task cannot start, rather than
 * dispatching a subagent with an empty prompt.
 */
export async function resolveTaskInstruction(
  frameworkRoot: string,
  workflowName: string,
  taskId: string,
  inline?: string,
  fallbackWorkflows?: string[],
  deps: ResolveTaskInstructionDeps = defaultDeps,
): Promise<string | undefined> {
  const baseId = taskId.includes(':') ? taskId.split(':').pop()! : taskId
  const chain = [workflowName, ...(fallbackWorkflows ?? [])]

  // 1. Project override (per workflow in chain)
  for (const wfName of chain) {
    const overridePath = path.join(
      frameworkRoot, '.dqa', 'overrides',
      wfName, 'tasks', `${baseId}.md`,
    )
    if (await fs.pathExists(overridePath)) {
      return fs.readFile(overridePath, 'utf-8')
    }
  }

  // 2. Local task pool (per workflow in chain) — `.dqa/tasks/<pool>/<id>.md`
  //
  //    ⭐ WITHOUT THIS, LOCAL CONTENT MODE IS A HALF-TRUTH. `loadWorkflow` already
  //       reads `.dqa/workflows/<name>.yaml` from disk, so a workflow loads fine
  //       offline — but every one of its agent-tasks then resolves to `undefined`
  //       and the subagent is dispatched with guardrails and no instruction.
  //       Measured on a real content tree: 203 instruction files unreachable.
  //
  //    The pool name comes from the workflow's `task-instructions-from`, same
  //    chain the override lookup walks — so a role-scoped workflow inherits from
  //    its shared pool exactly as it does against the content server.
  for (const wfName of chain) {
    const poolPath = path.join(frameworkRoot, '.dqa', 'tasks', wfName, `${baseId}.md`)
    if (await fs.pathExists(poolPath)) {
      return fs.readFile(poolPath, 'utf-8')
    }
  }

  // 3. Inline schema field
  if (inline) return inline

  // 4. Remote render — try each workflow in chain until one succeeds
  if (deps.isRemoteContentMode()) {
    let lastError: unknown
    for (const wfName of chain) {
      try {
        return await deps.fetchTaskInstruction(wfName, baseId)
      } catch (err) {
        lastError = err
        // try next in chain
      }
    }
    if (lastError) throw lastError
  }

  return undefined
}
