import { z } from 'zod'

// ── Task (was Artifact) ─────────────────────────────────────────────────────

export const TaskDefinitionSchema = z.object({
  id: z.string(),
  description: z.string(),
  outputPath: z.string(),
  dependencies: z.array(z.string()).default([]),
  template: z.string().optional(),
  instruction: z.string().optional(),
  rules: z.string().optional(),
})

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>
export type TaskStatus = 'ready' | 'blocked' | 'done'

export interface TaskStatusResult {
  id: string
  outputPath: string
  status: TaskStatus
  missingDeps?: string[]
}

// ── Gate (new first-class concept) ──────────────────────────────────────────

export const GateDefinitionSchema = z.object({
  id: z.string(),
  after: z.string().optional(),
  requires: z.array(z.string()).optional(),
  type: z.enum(['human-approval', 'automated-check']),
  description: z.string(),
})

export type GateDefinition = z.infer<typeof GateDefinitionSchema>

export type GateStatus = 'passed' | 'pending' | 'blocked'

export interface GateStatusResult {
  id: string
  type: GateDefinition['type']
  description: string
  status: GateStatus
  blockedBy?: string[]
}

// ── Workflow (was Schema) ───────────────────────────────────────────────────

/**
 * Accepts BOTH old format (artifacts + applyRequires) and new format (tasks + gates).
 * Normalizes to canonical form: { name, tasks, gates, applyRequires }
 */
export const WorkflowSchemaDefinition = z.object({
  name: z.string(),
  description: z.string().optional(),
  // Old format
  artifacts: z.array(TaskDefinitionSchema).optional(),
  applyRequires: z.array(z.string()).optional(),
  // New format
  tasks: z.array(TaskDefinitionSchema).optional(),
  gates: z.array(GateDefinitionSchema).optional(),
}).refine(
  d => (d.artifacts && d.artifacts.length > 0) || (d.tasks && d.tasks.length > 0),
  { message: 'Either "artifacts" or "tasks" must be provided with at least one entry' }
).transform(d => {
  const tasks = d.tasks ?? d.artifacts ?? []
  const gates = d.gates ?? (d.applyRequires
    ? [{ id: 'apply-gate', requires: d.applyRequires, type: 'human-approval' as const, description: 'All required tasks must be complete before apply phase' }]
    : [])
  const applyRequires = d.applyRequires ?? (d.gates
    ? d.gates.flatMap(g => g.requires ?? [])
    : [])
  return {
    name: d.name,
    description: d.description,
    tasks,
    gates,
    applyRequires,
  }
})

export type WorkflowSchema = z.output<typeof WorkflowSchemaDefinition>

export interface ChangeStatusResult {
  changeName: string
  schemaName: string
  isComplete: boolean
  applyRequires: string[]
  tasks: TaskStatusResult[]
  layerCompletion?: {
    backend: { complete: number; total: number }
    frontend: { complete: number; total: number }
    infra: { complete: number; total: number }
    tests: { complete: number; total: number }
    overall: 'DONE' | 'NOT DONE'
    storiesTotal: number
    storiesDone: number
  }
}

export interface ChangeMetadata {
  name: string
  schema: string
  domainLocked?: boolean
  domainVersion?: string
  // V3 provenance (DQA-specific)
  createdAt?: string
  createdBy?: string
  // Doc-ingestion linkage (DQA-specific)
  ingestedFrom?: string
}

// ── Context layers (v2.0) ───────────────────────────────────────────────────

export interface ContextLayers {
  /** Global context — always injected (constitution, AGENTS.md) */
  global: {
    constitution: string
    agentsMd: string
  }
  /** Workflow context — per-workflow (description, project config) */
  workflow: {
    description: string
    projectContext: string
  }
  /** Task context — per-task (instruction, template, rules, deps) */
  task: {
    instruction: string
    template: string
    rules: string
    dependencies: Array<{
      id: string
      done: boolean
      path: string
      description: string
    }>
    unlocks: string[]
  }
}

// ── Prompt payload (was InstructionsResult) ─────────────────────────────────

export interface PromptPayload {
  changeName: string
  artifactId: string
  schemaName: string
  changeDir: string
  outputPath: string
  description: string
  instruction: string
  template: string
  context: string
  rules: string
  dependencies: Array<{
    id: string
    done: boolean
    path: string
    description: string
  }>
  unlocks: string[]
  /** Structured context layers (v2.0) */
  layers?: ContextLayers
}

// ── Layer tracking types (v1.2) ──────────────────────────────────────────────

export type LayerStatus =
  | '✓'
  | '✗ NOT STARTED'
  | '⚙ IN PROGRESS'
  | '⚠ PARTIAL'
  | '—'

export interface StoryLayerEntry {
  storyId: string
  description: string
  backend: LayerStatus
  frontend: LayerStatus
  infra: LayerStatus
  tests: LayerStatus
  status: 'DONE' | 'IN PROGRESS' | 'NOT STARTED'
}

export interface LayerMap {
  projectName: string
  updatedAt: string
  stories: StoryLayerEntry[]
  summary: {
    backend: { complete: number; total: number }
    frontend: { complete: number; total: number }
    infra: { complete: number; total: number }
    tests: { complete: number; total: number }
    overall: 'DONE' | 'NOT DONE'
  }
}

// ── UX Delta types (v1.6) ────────────────────────────────────────────────────

export type InteractionStateType = 'loading' | 'error' | 'empty' | 'optimistic'

export interface InteractionState {
  element: string
  stateType: InteractionStateType
  trigger: string
  recovery: string
}

export interface UxScreenDelta {
  screenName: string
  change: string
  elementsAdded: string[]
  elementsRemoved: string[]
  interactionStates: InteractionState[]
}

export interface UxDelta {
  changeName: string
  date: string
  modifiedScreens: UxScreenDelta[]
  newScreens: string[]
  staleScreens: Array<{ screenName: string; reason: string }>
  bddScenariosGenerated: number
}

// ── Rule Conflict types (v1.6) ──────────────────────────────────────────────

export type ConflictType = 'type-a' | 'type-b' | 'type-c'
export type ConflictSeverity = 'critical' | 'warning'

export interface RuleConflict {
  id: string
  type: ConflictType
  severity: ConflictSeverity
  rules: string[]
  concept: string
  description: string
  risk: string
  resolved: boolean
  resolution?: string
}

export interface RuleConflictsReport {
  rulesScanned: number
  conflictsFound: number
  critical: RuleConflict[]
  warnings: RuleConflict[]
  cleanRulesCount: number
}

// ── Risk Report types (v1.6) ────────────────────────────────────────────────

export type RiskTier = 'HIGH' | 'MEDIUM' | 'LOW'

export interface ContextRiskScore {
  context: string
  rulesCount: number
  coveragePercent: number
  uncertainCount: number
  volatileCount: number
  conflictsCount: number
  highRecency: boolean
  score: number
  tier: RiskTier
}

export interface OnboardRiskReport {
  projectName: string
  generatedAt: string
  boundedContexts: number
  totalRules: number
  contexts: ContextRiskScore[]
  remediationOrder: {
    blocking: string[]
    highExposure: string[]
    futureRisk: string[]
  }
}

// ── Migration Score types (v1.6) ────────────────────────────────────────────

export type MigrationTier = 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'COMPLEX'

export interface MigrationEffortBreakdown {
  category: string
  count: number
  points: number
}

export interface MigrationScore {
  projectName: string
  generatedAt: string
  totalPoints: number
  totalHours: number
  tier: MigrationTier
  blockingItems: number
  nonBlockingItems: number
  breakdown: MigrationEffortBreakdown[]
  phasedPlan?: Array<{ phase: string; points: number; description: string }>
  alreadySolid: {
    confirmedRules: number
    lowRiskContexts: number
    strongestArea: string
  }
}

// ── Onboard types (v1.2) ─────────────────────────────────────────────────────

export type OnboardConfidence = 'CONFIRMED' | 'INFERRED' | 'UNCERTAIN' | 'NEEDS_REVIEW'

export interface OnboardEntity {
  name: string
  confidence: OnboardConfidence
  context: string
  sourceFile?: string
}

export interface OnboardResult {
  projectName: string
  entitiesFound: OnboardEntity[]
  eventsFound: string[]
  rulesFound: number
  techStack: string[]
  layersPresent: string[]
  uncertainCount: number
  inferredCount: number
  confirmedCount: number
}
