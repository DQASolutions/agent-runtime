import { z } from 'zod'

// ── Structured step outputs ────────────────────────────────────────────────
//
// A step may DECLARE the typed values it produces (beyond "a file exists").
// The engine captures those values at `done` time, validates them against this
// spec, and stores them per-step in run state so downstream `when:` / inputs
// can branch on them deterministically (the agent supplies data; the engine
// decides flow).
//
// The spec is intentionally a small, recursive, serializable type descriptor —
// scalars + enum + object + array — so new shapes are added by extending the
// union, never by special-casing call sites.

/** Recursive, serializable descriptor for one declared output value. */
export type OutputTypeSpec =
  | { type: 'string'; optional?: boolean; description?: string }
  | { type: 'number'; optional?: boolean; description?: string }
  | { type: 'boolean'; optional?: boolean; description?: string }
  | { type: 'enum'; values: string[]; optional?: boolean; description?: string }
  | { type: 'object'; fields: Record<string, OutputTypeSpec>; optional?: boolean; description?: string }
  | { type: 'array'; items: OutputTypeSpec; optional?: boolean; description?: string }

/** A step's declared outputs: field name → type spec. */
export type OutputsDecl = Record<string, OutputTypeSpec>

export const OutputTypeSpecSchema: z.ZodType<OutputTypeSpec> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('string'), optional: z.boolean().optional(), description: z.string().optional() }),
    z.object({ type: z.literal('number'), optional: z.boolean().optional(), description: z.string().optional() }),
    z.object({ type: z.literal('boolean'), optional: z.boolean().optional(), description: z.string().optional() }),
    z.object({ type: z.literal('enum'), values: z.array(z.string()).min(1), optional: z.boolean().optional(), description: z.string().optional() }),
    z.object({ type: z.literal('object'), fields: z.record(z.string(), OutputTypeSpecSchema), optional: z.boolean().optional(), description: z.string().optional() }),
    z.object({ type: z.literal('array'), items: OutputTypeSpecSchema, optional: z.boolean().optional(), description: z.string().optional() }),
  ]),
)

export const OutputsSchema = z.record(z.string(), OutputTypeSpecSchema)

// ── Agent Task (default) ───────────────────────────────────────────────────

const AgentTaskSchema = z.object({
  id: z.string(),
  type: z.literal('agent-task').default('agent-task'),
  output: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  depends: z.array(z.string()).default([]),
  when: z.string().optional(),
  instruction: z.string().optional(),
  guidance: z.string().optional(),
  guardrails: z.array(z.string()).optional(),
  template: z.string().optional(),
  'output-format': z.string().optional(),
  exports: z.record(z.string(), z.string()).optional(),
  /**
   * Declared, typed values this step produces (in addition to its output
   * file). Captured + validated at `done`, stored per-step in run state, and
   * referenceable downstream as `<step-id>.<field>` in `when:` / `validate:`.
   */
  outputs: OutputsSchema.optional(),
  /**
   * Name of a registered StepExecutor that the engine runs to EXECUTE this step
   * (instead of the caller / a subagent). The kernel drives the step; the app
   * stays declarative. `with` carries the executor's declarative parameters.
   */
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  validate: z.string().optional(),
  'min-output-count': z.number().optional(),
  /**
   * If true, this task is safe to run concurrently with adjacent tasks
   * that are also marked parallel-safe. Adjacency follows YAML declaration
   * order; a task without this flag (or without met deps) breaks the
   * chain. Default false — opt in only after auditing that this task
   * shares no mutable state, files, or globals with its parallel-safe
   * siblings. See the "Parallel dispatch" section of CLAUDE.md.
   */
  'parallel-safe': z.boolean().default(false),
  /**
   * Anthropic model tier for the subagent that executes this task.
   * Optional — when omitted, the dispatching CLAUDE.md template tells
   * Claude to default to "sonnet" (cost/speed balance). Workflow authors
   * opt into "opus" only for tasks that genuinely need deeper reasoning
   * (e.g. architecture synthesis, multi-document judging) and "haiku"
   * for trivial tasks (signoff drafting, gate validation).
   *
   * Empirical baseline (Spike S1, 2026-05-05): Opus is ~53% slower than
   * Sonnet on the same DQA task, with marginal quality bonus. Default
   * Sonnet unless a task explicitly opts in.
   */
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
})

// ── Gate Task ──────────────────────────────────────────────────────────────

const GateTaskSchema = z.object({
  id: z.string(),
  type: z.literal('gate'),
  'gate-type': z.enum(['approval', 'check']),
  depends: z.array(z.string()).default([]),
  description: z.string(),
  check: z.string().optional(),
  instruction: z.string().optional(),
  output: z.string().optional(),
  /**
   * Condition expression evaluated before this gate fires. When the
   * expression evaluates to false the gate is auto-skipped (written as
   * 'skipped' in state) so downstream tasks are not blocked.
   *
   * Typical use: conditional hand-off gates that only apply when a
   * prior task produced a specific artifact (e.g. plan.md exists only
   * for complex stories). Evaluated the same way as agent-task `when`.
   */
  when: z.string().optional(),
  // ── Schema 3.1 additions (optional, additive) ──────────────────────────
  /**
   * Role ID required to approve this gate (only meaningful for
   * gate-type=approval). When absent, any actor may approve. Used by
   * enterprise composites to enforce role-based approval routing.
   */
  'approver-role': z.string().optional(),
  /**
   * Cross-workflow gate dependencies. Each entry references a sibling run
   * in the same project that must have approved a specific gate before
   * this gate can fire. Used by Composite orchestration to coordinate
   * role workflows.
   */
  'depends-on-run': z.array(z.object({
    run: z.string(),
    gate: z.string(),
  })).optional(),
  /**
   * ArtifactBundle IDs that must be produced before this gate fires.
   * Used to enforce hand-off completeness at workflow boundaries.
   */
  'bundles-required': z.array(z.string()).optional(),
})

// ── Parallel Task ──────────────────────────────────────────────────────────

const ParallelTaskSchema: z.ZodType = z.object({
  id: z.string(),
  type: z.literal('parallel'),
  depends: z.array(z.string()).default([]),
  when: z.string().optional(),
  tasks: z.array(z.lazy(() => TaskV3Schema)).min(1),
})

// ── Switch Task ────────────────────────────────────────────────────────────

const SwitchTaskSchema: z.ZodType = z.object({
  id: z.string(),
  type: z.literal('switch'),
  depends: z.array(z.string()).default([]),
  eval: z.string(),
  routes: z.record(z.string(), z.array(z.lazy(() => TaskV3Schema))),
  default: z.array(z.lazy(() => TaskV3Schema)).optional(),
})

// ── For-Each Task ──────────────────────────────────────────────────────────

const ForEachTaskSchema: z.ZodType = z.object({
  id: z.string(),
  type: z.literal('for-each'),
  depends: z.array(z.string()).default([]),
  source: z.string(),
  filter: z.string().optional(),
  as: z.string(),
  'sub-tasks': z.array(z.lazy(() => TaskV3Schema)).min(1),
})

// ── Action Task ────────────────────────────────────────────────────────────

const ActionTaskSchema = z.object({
  id: z.string(),
  type: z.literal('action'),
  depends: z.array(z.string()).default([]),
  when: z.string().optional(),
  run: z.string().optional(),
  output: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: OutputsSchema.optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  validate: z.string().optional(),
})

// ── Task (discriminated union) ─────────────────────────────────────────────

export const TaskV3Schema = z.union([
  GateTaskSchema,
  ParallelTaskSchema,
  SwitchTaskSchema,
  ForEachTaskSchema,
  ActionTaskSchema,
  AgentTaskSchema, // last — catches default (no type field)
])

export type TaskV3 = z.infer<typeof TaskV3Schema>

// ── Pipeline Entry ─────────────────────────────────────────────────────────

export const PipelineEntrySchema = z.object({
  phase: z.string(),
  when: z.string().optional(),
})

export type PipelineEntry = z.infer<typeof PipelineEntrySchema>

// ── Phase Body ─────────────────────────────────────────────────────────────

export const PhaseBodySchema = z.object({
  description: z.string().optional(),
  tasks: z.array(TaskV3Schema).min(1),
})

export type PhaseBody = z.infer<typeof PhaseBodySchema>

// ── Workflow V3 ────────────────────────────────────────────────────────────

export const WorkflowV3Schema = z.object({
  name: z.string(),
  version: z.union([z.number(), z.string()]),
  description: z.string().optional(),
  extends: z.string().optional(),
  prereq: z.string().optional(),
  pipeline: z.array(PipelineEntrySchema).min(1),
  phases: z.record(z.string(), PhaseBodySchema),
  // ── Schema 3.1 additions (optional, additive) ────────────────────────────
  /**
   * Schema spec version this YAML conforms to. Distinct from `version`
   * (which is the workflow author's content version). Migration tool
   * uses this field. Defaults to "3.1" for files that omit it.
   */
  'schema-version': z.string().default('3.1'),
  /**
   * Role ID this workflow is bound to (e.g. "ba", "architect"). When
   * present, the workflow's gates default `approver-role` to this value
   * unless explicitly overridden. References a Role primitive.
   */
  role: z.string().optional(),
  /**
   * ArtifactBundle IDs this workflow outputs. Used by Composite
   * orchestration to validate hand-off chain (consumer's `consumes`
   * must match producer's `produces`).
   */
  produces: z.array(z.string()).default([]),
  /**
   * ArtifactBundle IDs this workflow needs as input.
   */
  consumes: z.array(z.string()).default([]),
  /**
   * Vendor-namespaced custom fields. Keys MUST follow `<vendor>.<field>`
   * format (e.g. `myorg.cost-center`). Core engine ignores; plugins
   * may read.
   */
  extensions: z.record(z.string(), z.unknown()).optional(),
  /**
   * Fallback workflow name(s) whose `tasks/<workflow>/<task-id>.md`
   * namespace is searched when this workflow's own namespace doesn't
   * have the file. Accepts a single string or an array (walked in order).
   *
   * Used by role-scoped workflows to inherit instructions from a shared
   * pool — e.g. `dqa-ba` declares `task-instructions-from: ba` and the
   * resolver will read instructions from `tasks/ba/<id>.md`. Legacy
   * `dqa.yaml` declares the array form to span all role folders.
   *
   * Resolver precedence: project override → inline → own namespace →
   * each fallback in array order.
   */
  'task-instructions-from': z.union([
    z.string(),
    z.array(z.string()),
  ]).optional(),
}).refine(
  (d) => {
    // Validate all pipeline phase refs exist in phases map
    for (const entry of d.pipeline) {
      if (!(entry.phase in d.phases)) {
        return false
      }
    }
    return true
  },
  { message: 'Pipeline references a phase that is not defined in phases' }
)

/** A workflow after `WorkflowV3Schema.parse`: every default filled in. */
export type ParsedWorkflowV3 = z.infer<typeof WorkflowV3Schema>

/**
 * A workflow as the engine takes it. Hosts load workflow YAML without parsing it
 * through the schema, so the fields that only have a schema default
 * (`schema-version`, `produces`, `consumes`) may be absent; nothing in the engine
 * reads them. A parsed workflow is also a WorkflowV3.
 */
export type WorkflowV3 = Omit<ParsedWorkflowV3, 'schema-version' | 'produces' | 'consumes'> &
  Partial<Pick<ParsedWorkflowV3, 'schema-version' | 'produces' | 'consumes'>>

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ Schema 3.1 — Role / ArtifactBundle / Composite primitives                ║
// ║                                                                          ║
// ║ These primitives support role-based workflow separation and multi-       ║
// ║ workflow orchestration. All optional on existing Workflow/Gate schemas,  ║
// ║ so v3.0 YAML continues to parse and run unchanged.                       ║
// ║                                                                          ║
// ║ Spec: docs/design-role-workflow-handoff-formats.md                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const SlugIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  message: 'id must be lowercase-kebab-case starting with a letter',
})

const ExtensionsSchema = z.record(z.string(), z.unknown()).optional()

// ── Role ───────────────────────────────────────────────────────────────────

export const RoleSchema = z.object({
  'schema-version': z.string().default('3.1'),
  id: SlugIdSchema,
  name: z.string(),
  description: z.string(),
  responsibilities: z.array(z.string()).default([]),
  produces: z.array(z.string()).default([]),
  consumes: z.array(z.string()).default([]),
  extends: z.string().optional(),
  extensions: ExtensionsSchema,
})

export type Role = z.infer<typeof RoleSchema>

// ── ArtifactSpec ───────────────────────────────────────────────────────────

export const ArtifactSpecSchema = z.object({
  path: z.string(),
  format: z.enum(['markdown', 'yaml', 'json', 'openapi', 'mermaid', 'binary', 'gherkin']),
  'schema-ref': z.string().optional(),
  'required-sections': z.array(z.string()).optional(),
  'min-count': z.number().optional(),
  validate: z.string().optional(),
  description: z.string().optional(),
})

export type ArtifactSpec = z.infer<typeof ArtifactSpecSchema>

// ── AcceptanceRule ─────────────────────────────────────────────────────────

export const AcceptanceRuleSchema = z.object({
  rule: z.string(),
  severity: z.enum(['error', 'warning']).default('error'),
  message: z.string().optional(),
})

export type AcceptanceRule = z.infer<typeof AcceptanceRuleSchema>

// ── ArtifactBundle ─────────────────────────────────────────────────────────

export const ArtifactBundleSchema = z.object({
  'schema-version': z.string().default('3.1'),
  id: SlugIdSchema,
  description: z.string(),
  artifacts: z.array(ArtifactSpecSchema).min(1),
  acceptance: z.array(AcceptanceRuleSchema).default([]),
  standard: z.object({
    spec: z.string(),
    url: z.string().optional(),
  }).optional(),
  extends: z.string().optional(),
  extensions: ExtensionsSchema,
})

export type ArtifactBundle = z.infer<typeof ArtifactBundleSchema>

// ── CompositeEntry ─────────────────────────────────────────────────────────

export const CompositeEntrySchema = z.object({
  workflow: z.string(),
  run: z.string().optional(),
  'depends-on': z.array(z.object({
    workflow: z.string(),
    gate: z.string(),
  })).default([]),
  when: z.string().optional(),
})

export type CompositeEntry = z.infer<typeof CompositeEntrySchema>

// ── Composite ──────────────────────────────────────────────────────────────

export const CompositeSchema = z.object({
  'schema-version': z.string().default('3.1'),
  id: SlugIdSchema,
  description: z.string(),
  workflows: z.array(CompositeEntrySchema).min(1),
  'default-approver': z.string().optional(),
  extends: z.string().optional(),
  extensions: ExtensionsSchema,
})

export type Composite = z.infer<typeof CompositeSchema>
