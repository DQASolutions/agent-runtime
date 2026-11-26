import { describe, it, expect } from 'vitest'
import {
  WorkflowV3Schema,
  TaskV3Schema,
  PipelineEntrySchema,
  PhaseBodySchema,
  RoleSchema,
  ArtifactSpecSchema,
  AcceptanceRuleSchema,
  ArtifactBundleSchema,
  CompositeEntrySchema,
  CompositeSchema,
} from './schema-types-v3.js'

// TaskV3 is `unknown` (its recursive members are typed as plain z.ZodType), so read parsed fields through this.
type TaskFields = Record<string, any>

// ── Helpers ────────────────────────────────────────────────────────────────

const minimalWorkflow = {
  name: 'test-workflow',
  version: 3,
  pipeline: [{ phase: 'phase-a' }],
  phases: {
    'phase-a': {
      description: 'Test phase',
      tasks: [
        { id: 'task-1', output: 'output.md', instruction: 'Do something' },
      ],
    },
  },
}

// ── WorkflowV3Schema ───────────────────────────────────────────────────────

describe('WorkflowV3Schema', () => {
  it('parses minimal valid v3 schema', () => {
    const result = WorkflowV3Schema.safeParse(minimalWorkflow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('test-workflow')
      expect(result.data.version).toBe(3)
      expect(result.data.pipeline).toHaveLength(1)
      expect(result.data.phases['phase-a'].tasks).toHaveLength(1)
    }
  })

  it('rejects schema missing pipeline', () => {
    const result = WorkflowV3Schema.safeParse({
      name: 'test',
      version: 3,
      phases: { a: { description: 'x', tasks: [{ id: 't', output: 'o.md' }] } },
    })
    expect(result.success).toBe(false)
  })

  it('rejects schema missing phases', () => {
    const result = WorkflowV3Schema.safeParse({
      name: 'test',
      version: 3,
      pipeline: [{ phase: 'a' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects pipeline referencing undefined phase id', () => {
    const result = WorkflowV3Schema.safeParse({
      name: 'test',
      version: 3,
      pipeline: [{ phase: 'nonexistent' }],
      phases: {
        'phase-a': {
          description: 'x',
          tasks: [{ id: 't', output: 'o.md' }],
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('parses schema with optional fields', () => {
    const result = WorkflowV3Schema.safeParse({
      ...minimalWorkflow,
      description: 'A test workflow',
      extends: 'base-workflow',
      prereq: 'file-exists(domain.md)',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.description).toBe('A test workflow')
      expect(result.data.extends).toBe('base-workflow')
      expect(result.data.prereq).toBe('file-exists(domain.md)')
    }
  })
})

// ── TaskV3Schema ───────────────────────────────────────────────────────────

describe('TaskV3Schema', () => {
  it('parses agent-task with all fields', () => {
    const result = TaskV3Schema.safeParse({
      id: 'domain',
      type: 'agent-task',
      output: 'domain.md',
      depends: ['intake'],
      when: 'scoping.route includes C1',
      instruction: 'Extract domain model',
      guidance: 'Focus on entities',
      guardrails: ['Max 150 lines'],
      template: '# Domain\n...',
      'output-format': '## Summary\n...',
      exports: { 'entity-count': '$.entities.length' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as TaskFields).id).toBe('domain')
      expect((result.data as TaskFields).type).toBe('agent-task')
    }
  })

  it('parses agent-task with model: sonnet (Schema 3.1 — Spike S1 default)', () => {
    const result = TaskV3Schema.safeParse({
      id: 'domain',
      output: 'domain.md',
      model: 'sonnet',
    })
    expect(result.success).toBe(true)
    if (result.success && ((result.data as TaskFields).type === 'agent-task' || !(result.data as TaskFields).type)) {
      expect((result.data as { model?: string }).model).toBe('sonnet')
    }
  })

  it('parses agent-task with model: opus (opt-in for deep reasoning)', () => {
    const result = TaskV3Schema.safeParse({
      id: 'architecture',
      output: 'architecture.md',
      model: 'opus',
    })
    expect(result.success).toBe(true)
  })

  it('parses agent-task with model: haiku (trivial tasks)', () => {
    const result = TaskV3Schema.safeParse({
      id: 'gate-summary',
      output: 'summary.md',
      model: 'haiku',
    })
    expect(result.success).toBe(true)
  })

  it('rejects agent-task with invalid model value', () => {
    const result = TaskV3Schema.safeParse({
      id: 'bad',
      output: 'x.md',
      model: 'gpt-4',
    })
    expect(result.success).toBe(false)
  })

  it('agent-task without model defaults to undefined (CLAUDE.md template applies sonnet)', () => {
    const result = TaskV3Schema.safeParse({
      id: 'no-model',
      output: 'x.md',
    })
    expect(result.success).toBe(true)
    if (result.success && ((result.data as TaskFields).type === 'agent-task' || !(result.data as TaskFields).type)) {
      expect((result.data as { model?: string }).model).toBeUndefined()
    }
  })

  it('defaults type to agent-task when omitted', () => {
    const result = TaskV3Schema.safeParse({
      id: 'task-1',
      output: 'output.md',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as TaskFields).type).toBe('agent-task')
    }
  })

  it('defaults depends to empty array when omitted', () => {
    const result = TaskV3Schema.safeParse({
      id: 'task-1',
      output: 'output.md',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as TaskFields).depends).toEqual([])
    }
  })

  it('accepts agent-task without output field (code tasks write to workspace, no path needed)', () => {
    const result = TaskV3Schema.safeParse({
      id: 'task-1',
      type: 'agent-task',
      instruction: 'Do something',
    })
    expect(result.success).toBe(true)
  })

  it('parses gate task with gate-type approval', () => {
    const result = TaskV3Schema.safeParse({
      id: 'assumptions-gate',
      type: 'gate',
      'gate-type': 'approval',
      description: 'Approve assumptions',
      depends: ['intake'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as TaskFields).type).toBe('gate')
    }
  })

  it('parses gate task with gate-type check and check expression', () => {
    const result = TaskV3Schema.safeParse({
      id: 'convergence-gate',
      type: 'gate',
      'gate-type': 'check',
      description: 'Convergence must pass',
      check: 'convergence-report.status == PASS',
    })
    expect(result.success).toBe(true)
  })

  it('parses parallel task with nested tasks', () => {
    const result = TaskV3Schema.safeParse({
      id: 'parallel-group',
      type: 'parallel',
      tasks: [
        { id: 'rules', output: 'rules/BR-*.yml', instruction: 'Write rules' },
        { id: 'features', output: 'features/*.feature', instruction: 'Write BDD' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'parallel') {
      expect((result.data as TaskFields).tasks).toHaveLength(2)
    }
  })

  it('parses switch task with eval, routes, and default', () => {
    const result = TaskV3Schema.safeParse({
      id: 'complexity-route',
      type: 'switch',
      eval: 'domain.entities.count',
      routes: {
        simple: [
          { id: 'stories', output: 'stories/*.md', instruction: 'Write stories' },
        ],
        complex: [
          { id: 'bounded-contexts', output: 'bounded-contexts.md', instruction: 'Map contexts' },
        ],
      },
      default: [
        { id: 'fallback', output: 'fallback.md', instruction: 'Default path' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'switch') {
      expect(Object.keys((result.data as TaskFields).routes)).toEqual(['simple', 'complex'])
    }
  })

  it('parses for-each task with source, as, sub-tasks', () => {
    const result = TaskV3Schema.safeParse({
      id: 'implementation',
      type: 'for-each',
      source: 'stories/story-*.md',
      as: 'story',
      'sub-tasks': [
        { id: 'analyze', output: 'analysis.md', instruction: 'Analyze story' },
        { id: 'code', output: 'src/', instruction: 'Implement' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'for-each') {
      expect((result.data as TaskFields).source).toBe('stories/story-*.md')
      expect((result.data as TaskFields).as).toBe('story')
      expect((result.data as TaskFields)['sub-tasks']).toHaveLength(2)
    }
  })

  it('parses action task with run command', () => {
    const result = TaskV3Schema.safeParse({
      id: 'commit',
      type: 'action',
      run: 'git commit -m "feat: {story.id}"',
      validate: 'git log -1',
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'action') {
      expect((result.data as TaskFields).run).toContain('git commit')
    }
  })

  it('rejects task with unknown type', () => {
    const result = TaskV3Schema.safeParse({
      id: 'bad',
      type: 'unknown-type',
      output: 'x.md',
    })
    expect(result.success).toBe(false)
  })
})

// ── PipelineEntrySchema ────────────────────────────────────────────────────

describe('PipelineEntrySchema', () => {
  it('parses entry with only phase ref', () => {
    const result = PipelineEntrySchema.safeParse({ phase: 'discover' })
    expect(result.success).toBe(true)
  })

  it('parses entry with when condition', () => {
    const result = PipelineEntrySchema.safeParse({
      phase: 'security',
      when: 'constitution.compliance != none',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.when).toBe('constitution.compliance != none')
    }
  })

  it('rejects entry with removed `gate` field (migrate to a type:gate task)', () => {
    const result = PipelineEntrySchema.safeParse({
      phase: 'discover',
      gate: { type: 'approval', description: 'Stories locked after approval' },
    })
    // PipelineEntrySchema no longer accepts a `gate` key — zod strips unknown
    // keys by default, so the parse succeeds but the value is absent. We assert
    // the field is truly gone, which is enough to catch a regression that
    // tries to add phase-level gates back.
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as { gate?: unknown }).gate).toBeUndefined()
    }
  })
})

// ── PhaseBodySchema ────────────────────────────────────────────────────────

describe('PhaseBodySchema', () => {
  it('parses phase with description and tasks', () => {
    const result = PhaseBodySchema.safeParse({
      description: 'Discover phase',
      tasks: [
        { id: 'intake', output: 'raw-brief.md', instruction: 'Interview' },
        { id: 'domain', output: 'domain.md', depends: ['intake'], instruction: 'Extract' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tasks).toHaveLength(2)
    }
  })

  it('rejects phase with empty tasks array', () => {
    const result = PhaseBodySchema.safeParse({
      description: 'Empty phase',
      tasks: [],
    })
    expect(result.success).toBe(false)
  })
})

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ Schema 3.1 — Role / ArtifactBundle / Composite                           ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── RoleSchema ─────────────────────────────────────────────────────────────

describe('RoleSchema', () => {
  it('parses minimal valid role', () => {
    const result = RoleSchema.safeParse({
      id: 'ba',
      name: 'Business Analyst',
      description: 'Owns requirements engineering',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.id).toBe('ba')
      expect(result.data['schema-version']).toBe('3.1')
      expect(result.data.responsibilities).toEqual([])
      expect(result.data.produces).toEqual([])
      expect(result.data.consumes).toEqual([])
    }
  })

  it('parses role with all fields', () => {
    const result = RoleSchema.safeParse({
      'schema-version': '3.1',
      id: 'architect',
      name: 'Software Architect',
      description: 'Owns architecture definition',
      responsibilities: ['4+1 views', 'ADRs'],
      produces: ['architecture-description'],
      consumes: ['srs-baseline'],
      extends: 'server:roles/architect',
      extensions: { 'myorg.cost-center': 'CC-Eng' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.produces).toEqual(['architecture-description'])
      expect(result.data.consumes).toEqual(['srs-baseline'])
      expect(result.data.extensions?.['myorg.cost-center']).toBe('CC-Eng')
    }
  })

  it('rejects role with non-kebab id', () => {
    const result = RoleSchema.safeParse({
      id: 'BusinessAnalyst',
      name: 'BA',
      description: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects role with id starting with digit', () => {
    const result = RoleSchema.safeParse({
      id: '1ba',
      name: 'BA',
      description: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects role missing name', () => {
    const result = RoleSchema.safeParse({
      id: 'ba',
      description: 'x',
    })
    expect(result.success).toBe(false)
  })
})

// ── ArtifactSpecSchema ─────────────────────────────────────────────────────

describe('ArtifactSpecSchema', () => {
  it('parses minimal markdown spec', () => {
    const result = ArtifactSpecSchema.safeParse({
      path: 'spec/domain.md',
      format: 'markdown',
    })
    expect(result.success).toBe(true)
  })

  it('parses spec with all fields', () => {
    const result = ArtifactSpecSchema.safeParse({
      path: 'spec/stories/story-*.md',
      format: 'markdown',
      'schema-ref': 'server:schemas/story.schema.json',
      'required-sections': ['Functional Requirements', 'Non-Functional Requirements'],
      'min-count': 1,
      validate: 'glob-count(spec/stories/story-*.md) >= 1',
      description: 'EARS-formatted user stories',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data['min-count']).toBe(1)
      expect(result.data['required-sections']).toHaveLength(2)
    }
  })

  it('rejects spec with unknown format', () => {
    const result = ArtifactSpecSchema.safeParse({
      path: 'foo.xyz',
      format: 'protobuf',
    })
    expect(result.success).toBe(false)
  })

  it('parses gherkin format for BDD features', () => {
    const result = ArtifactSpecSchema.safeParse({
      path: 'features/*.feature',
      format: 'gherkin',
    })
    expect(result.success).toBe(true)
  })
})

// ── AcceptanceRuleSchema ───────────────────────────────────────────────────

describe('AcceptanceRuleSchema', () => {
  it('parses rule with default severity', () => {
    const result = AcceptanceRuleSchema.safeParse({
      rule: 'glob-count(stories/*.md) >= 1',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.severity).toBe('error')
    }
  })

  it('parses rule with warning severity', () => {
    const result = AcceptanceRuleSchema.safeParse({
      rule: 'file-exists(optional.md)',
      severity: 'warning',
      message: 'Optional file missing',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.severity).toBe('warning')
      expect(result.data.message).toBe('Optional file missing')
    }
  })

  it('rejects unknown severity', () => {
    const result = AcceptanceRuleSchema.safeParse({
      rule: 'x',
      severity: 'critical',
    })
    expect(result.success).toBe(false)
  })
})

// ── ArtifactBundleSchema ───────────────────────────────────────────────────

describe('ArtifactBundleSchema', () => {
  it('parses minimal valid bundle', () => {
    const result = ArtifactBundleSchema.safeParse({
      id: 'srs-baseline',
      description: 'SRS baseline',
      artifacts: [
        { path: 'spec/domain.md', format: 'markdown' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.acceptance).toEqual([])
      expect(result.data['schema-version']).toBe('3.1')
    }
  })

  it('parses bundle with full hand-off contract', () => {
    const result = ArtifactBundleSchema.safeParse({
      id: 'srs-baseline',
      description: 'SRS baseline',
      artifacts: [
        { path: 'spec/domain.md', format: 'markdown' },
        { path: 'spec/stories/*.md', format: 'markdown', 'min-count': 1 },
      ],
      acceptance: [
        { rule: 'file-exists(spec/domain.md)', severity: 'error' },
        { rule: 'glob-count(spec/stories/*.md) >= 1', severity: 'error' },
      ],
      standard: {
        spec: 'ISO/IEC/IEEE 29148:2018 §11',
        url: 'https://www.iso.org/standard/72089.html',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.acceptance).toHaveLength(2)
      expect(result.data.standard?.spec).toContain('29148')
    }
  })

  it('rejects bundle with empty artifacts array', () => {
    const result = ArtifactBundleSchema.safeParse({
      id: 'empty',
      description: 'x',
      artifacts: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects bundle with non-kebab id', () => {
    const result = ArtifactBundleSchema.safeParse({
      id: 'SRS_Baseline',
      description: 'x',
      artifacts: [{ path: 'x.md', format: 'markdown' }],
    })
    expect(result.success).toBe(false)
  })
})

// ── CompositeEntrySchema ───────────────────────────────────────────────────

describe('CompositeEntrySchema', () => {
  it('parses minimal entry', () => {
    const result = CompositeEntrySchema.safeParse({
      workflow: 'dqa-ba',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data['depends-on']).toEqual([])
    }
  })

  it('parses entry with cross-workflow dependency', () => {
    const result = CompositeEntrySchema.safeParse({
      workflow: 'dqa-architect',
      run: 'architect',
      'depends-on': [
        { workflow: 'dqa-ba', gate: 'srs-approval-gate' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data['depends-on']).toHaveLength(1)
      expect(result.data['depends-on'][0]).toEqual({
        workflow: 'dqa-ba',
        gate: 'srs-approval-gate',
      })
    }
  })

  it('rejects entry missing workflow field', () => {
    const result = CompositeEntrySchema.safeParse({
      run: 'ba',
    })
    expect(result.success).toBe(false)
  })
})

// ── CompositeSchema ────────────────────────────────────────────────────────

describe('CompositeSchema', () => {
  it('parses minimal composite', () => {
    const result = CompositeSchema.safeParse({
      id: 'solo',
      description: 'Single-actor end-to-end',
      workflows: [
        { workflow: 'dqa-ba' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('parses solo composite with full role chain', () => {
    const result = CompositeSchema.safeParse({
      id: 'solo',
      description: 'Single-actor end-to-end',
      'default-approver': 'self',
      workflows: [
        { workflow: 'dqa-ba', run: 'ba' },
        {
          workflow: 'dqa-architect',
          run: 'architect',
          'depends-on': [{ workflow: 'dqa-ba', gate: 'srs-approval-gate' }],
        },
        {
          workflow: 'dqa-dev',
          run: 'dev',
          'depends-on': [{ workflow: 'dqa-architect', gate: 'ad-approval-gate' }],
        },
        {
          workflow: 'dqa-qa',
          run: 'qa',
          'depends-on': [{ workflow: 'dqa-architect', gate: 'ad-approval-gate' }],
        },
        {
          workflow: 'dqa-release',
          run: 'release',
          'depends-on': [
            { workflow: 'dqa-dev', gate: 'build-approval-gate' },
            { workflow: 'dqa-qa', gate: 'test-approval-gate' },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.workflows).toHaveLength(5)
      expect(result.data['default-approver']).toBe('self')
    }
  })

  it('rejects composite with empty workflows', () => {
    const result = CompositeSchema.safeParse({
      id: 'empty',
      description: 'x',
      workflows: [],
    })
    expect(result.success).toBe(false)
  })
})

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ Schema 3.1 — Workflow & Gate extensions (additive on existing schemas)   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

describe('WorkflowV3Schema (3.1 extensions)', () => {
  const minimal = {
    name: 'test-workflow',
    version: 3,
    pipeline: [{ phase: 'phase-a' }],
    phases: {
      'phase-a': {
        description: 'Test phase',
        tasks: [{ id: 'task-1', output: 'output.md', instruction: 'Do something' }],
      },
    },
  }

  it('defaults schema-version to 3.1 when omitted (backwards compat)', () => {
    const result = WorkflowV3Schema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data['schema-version']).toBe('3.1')
      expect(result.data.produces).toEqual([])
      expect(result.data.consumes).toEqual([])
    }
  })

  it('parses workflow with role binding and bundle declarations', () => {
    const result = WorkflowV3Schema.safeParse({
      ...minimal,
      role: 'ba',
      produces: ['srs-baseline'],
      consumes: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.role).toBe('ba')
      expect(result.data.produces).toEqual(['srs-baseline'])
    }
  })

  it('parses workflow with vendor extensions', () => {
    const result = WorkflowV3Schema.safeParse({
      ...minimal,
      extensions: {
        'myorg.required-cert': 'CBAP',
        'myorg.cost-center': 'CC-Engineering',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.extensions?.['myorg.required-cert']).toBe('CBAP')
    }
  })
})

describe('GateTaskSchema (3.1 extensions)', () => {
  it('parses gate with approver-role', () => {
    const result = TaskV3Schema.safeParse({
      id: 'srs-approval-gate',
      type: 'gate',
      'gate-type': 'approval',
      description: 'SRS approval',
      'approver-role': 'ba',
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'gate') {
      expect((result.data as TaskFields)['approver-role']).toBe('ba')
    }
  })

  it('parses gate with cross-workflow dependencies', () => {
    const result = TaskV3Schema.safeParse({
      id: 'architecture-start',
      type: 'gate',
      'gate-type': 'check',
      description: 'Wait for BA hand-off',
      'depends-on-run': [
        { run: 'acme--ba', gate: 'srs-approval-gate' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'gate') {
      expect((result.data as TaskFields)['depends-on-run']).toHaveLength(1)
      expect((result.data as TaskFields)['depends-on-run']?.[0]).toEqual({
        run: 'acme--ba',
        gate: 'srs-approval-gate',
      })
    }
  })

  it('parses gate with bundles-required', () => {
    const result = TaskV3Schema.safeParse({
      id: 'ad-approval-gate',
      type: 'gate',
      'gate-type': 'approval',
      description: 'Architecture approval',
      'bundles-required': ['architecture-description'],
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'gate') {
      expect((result.data as TaskFields)['bundles-required']).toEqual(['architecture-description'])
    }
  })

  it('still parses legacy gate without 3.1 fields (backwards compat)', () => {
    const result = TaskV3Schema.safeParse({
      id: 'legacy-gate',
      type: 'gate',
      'gate-type': 'approval',
      description: 'Legacy gate from v3.0',
    })
    expect(result.success).toBe(true)
    if (result.success && (result.data as TaskFields).type === 'gate') {
      expect((result.data as TaskFields)['approver-role']).toBeUndefined()
      expect((result.data as TaskFields)['depends-on-run']).toBeUndefined()
      expect((result.data as TaskFields)['bundles-required']).toBeUndefined()
    }
  })
})
