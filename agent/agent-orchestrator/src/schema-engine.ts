import fs from 'fs-extra'
import path from 'node:path'
import yaml from 'js-yaml'
import { WorkflowSchemaDefinition, type WorkflowSchema, type TaskDefinition, type GateDefinition } from './schema-types.js'
import { WorkflowV3Schema, type ParsedWorkflowV3 } from './schema-types-v3.js'
import { isRemoteContentMode, fetchWorkflowContent } from './content-server-loader.js'

export type VersionedWorkflow =
  | (WorkflowSchema & { _version: 2 })
  | (ParsedWorkflowV3 & { _version: 3 })

/**
 * Detect whether a parsed YAML object is v2 or v3 format.
 */
export function detectSchemaVersion(parsed: Record<string, unknown>): 'v2' | 'v3' {
  if (parsed.pipeline && parsed.phases) return 'v3'
  if (parsed.tasks || parsed.artifacts) return 'v2'
  throw new Error('Cannot detect schema version: missing "pipeline"+"phases" (v3) or "tasks"/"artifacts" (v2)')
}

export async function loadWorkflow(name: string, frameworkRoot: string): Promise<VersionedWorkflow> {
  // 1. Project v3 workflow override in .dqa/workflows/<name>.yaml — always
  //    wins. Teams customize workflow here.
  const projectV3Path = path.join(frameworkRoot, '.dqa', 'workflows', `${name}.yaml`)
  if (await fs.pathExists(projectV3Path)) {
    return parseSchemaFile(projectV3Path)
  }

  // 2. Project v2 schema in .dqa/schemas/<name>.yaml (legacy project format).
  const projectV2Path = path.join(frameworkRoot, '.dqa', 'schemas', `${name}.yaml`)
  if (await fs.pathExists(projectV2Path)) {
    return parseSchemaFile(projectV2Path)
  }

  // 3. Remote content server (DQA_CONTENT_MODE=remote). IP content stays
  //    server-side; signed response verified before use.
  if (isRemoteContentMode()) {
    const doc = await fetchWorkflowContent(name)
    return validateParsedSchema(doc, `content-server:${name}`)
  }

  // No bundled fallback. Remote content is the canonical source for
  // official workflow definitions; customers offline without a project
  // override must set one at .dqa/workflows/<name>.yaml.
  throw new Error(
    `Workflow "${name}" not found. Add a project override at ` +
    `.dqa/workflows/${name}.yaml, OR set DQA_CONTENT_MODE=remote with ` +
    `a valid DQA_CONTENT_SERVER + license credentials.`,
  )
}

async function parseSchemaFile(filePath: string): Promise<VersionedWorkflow> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const parsed = yaml.load(raw) as Record<string, unknown>
  return validateParsedSchema(parsed, filePath)
}

function validateParsedSchema(parsed: Record<string, unknown>, sourceLabel: string): VersionedWorkflow {
  const version = detectSchemaVersion(parsed)

  if (version === 'v3') {
    const result = WorkflowV3Schema.safeParse(parsed)
    if (!result.success) {
      const errors = result.error.issues.map(e => `  ${String(e.path.join('.'))}: ${e.message}`).join('\n')
      throw new Error(`Invalid v3 schema at ${sourceLabel}:\n${errors}`)
    }
    return { ...result.data, _version: 3 as const }
  }

  const result = WorkflowSchemaDefinition.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues.map(e => `  ${String(e.path.join('.'))}: ${e.message}`).join('\n')
    throw new Error(`Invalid schema at ${sourceLabel}:\n${errors}`)
  }
  return { ...result.data, _version: 2 as const }
}

/**
 * Resolve tasks in topological order (dependencies before dependents).
 * Throws if a cycle is detected.
 */
export function resolveTaskOrder(schema: WorkflowSchema): TaskDefinition[] {
  const tasks = schema.tasks
  const byId = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const ordered: TaskDefinition[] = []

  function visit(id: string, chain: string[]) {
    if (inStack.has(id)) {
      const cycle = [...chain, id].join(' → ')
      throw new Error(`Circular dependency detected: ${cycle}`)
    }
    if (visited.has(id)) return

    const task = byId.get(id)
    if (!task) throw new Error(`Unknown artifact "${id}" referenced as dependency`)

    inStack.add(id)
    for (const dep of task.dependencies) {
      visit(dep, [...chain, id])
    }
    inStack.delete(id)
    visited.add(id)
    ordered.push(task)
  }

  for (const task of tasks) {
    visit(task.id, [])
  }

  return ordered
}

/**
 * For a given task, return the IDs of tasks it unblocks (i.e., that depend on it).
 */
export function getUnlocks(schema: WorkflowSchema, taskId: string): string[] {
  const tasks = schema.tasks
  return tasks
    .filter(t => t.dependencies.includes(taskId))
    .map(t => t.id)
}

/**
 * Return all gate definitions from the workflow.
 */
export function getGates(schema: WorkflowSchema): GateDefinition[] {
  return schema.gates
}

