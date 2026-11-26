import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveTaskOrder, getUnlocks, detectSchemaVersion, loadWorkflow } from './schema-engine.js'
import type { WorkflowSchema } from './schema-types.js'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'

const makeSchema = (tasks: Array<{ id: string; deps?: string[] }>): WorkflowSchema => ({
  name: 'test',
  description: undefined,
  applyRequires: [],
  gates: [],
  tasks: tasks.map(t => ({
    id: t.id,
    description: t.id,
    outputPath: `${t.id}.md`,
    dependencies: t.deps ?? [],
  })),
})

describe('resolveTaskOrder', () => {
  it('returns single task with no deps', () => {
    const schema = makeSchema([{ id: 'a' }])
    const order = resolveTaskOrder(schema)
    expect(order.map(t => t.id)).toEqual(['a'])
  })

  it('returns dependencies before dependents', () => {
    const schema = makeSchema([
      { id: 'c', deps: ['b'] },
      { id: 'a' },
      { id: 'b', deps: ['a'] },
    ])
    const order = resolveTaskOrder(schema)
    const ids = order.map(t => t.id)
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'))
  })

  it('throws on circular dependency', () => {
    const schema = makeSchema([
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['a'] },
    ])
    expect(() => resolveTaskOrder(schema)).toThrow(/circular/i)
  })

  it('throws on unknown dependency reference', () => {
    const schema = makeSchema([{ id: 'a', deps: ['nonexistent'] }])
    expect(() => resolveTaskOrder(schema)).toThrow(/nonexistent/)
  })
})

describe('getUnlocks', () => {
  it('returns tasks that depend on given id', () => {
    const schema = makeSchema([
      { id: 'a' },
      { id: 'b', deps: ['a'] },
      { id: 'c', deps: ['a'] },
      { id: 'd', deps: ['b'] },
    ])
    expect(getUnlocks(schema, 'a').sort()).toEqual(['b', 'c'])
    expect(getUnlocks(schema, 'b')).toEqual(['d'])
    expect(getUnlocks(schema, 'd')).toEqual([])
  })
})

// ── v2/v3 detection ────────────────────────────────────────────────────────

describe('detectSchemaVersion', () => {
  it('returns v2 for object with top-level tasks array', () => {
    expect(detectSchemaVersion({ name: 'test', tasks: [{ id: 'a' }] })).toBe('v2')
  })

  it('returns v3 for object with pipeline and phases', () => {
    expect(detectSchemaVersion({
      name: 'test',
      pipeline: [{ phase: 'a' }],
      phases: { a: { tasks: [] } },
    })).toBe('v3')
  })

  it('returns v2 for legacy artifacts array', () => {
    expect(detectSchemaVersion({ name: 'test', artifacts: [{ id: 'a' }] })).toBe('v2')
  })

  it('throws for object with neither tasks nor pipeline', () => {
    expect(() => detectSchemaVersion({ name: 'test' })).toThrow()
  })
})

// ── v3 loading ─────────────────────────────────────────────────────────────

describe('loadWorkflow with v3 format', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-schema-v3-'))
    await fs.mkdirp(path.join(tmpDir, '.dqa', 'schemas'))
  })

  afterEach(async () => {
    await fs.remove(tmpDir)
  })

  it('loads a valid v3 YAML file', async () => {
    const v3Schema = {
      name: 'test-v3',
      version: 3,
      pipeline: [{ phase: 'phase-a' }],
      phases: {
        'phase-a': {
          description: 'Test',
          tasks: [{ id: 'task-1', output: 'out.md', instruction: 'Do it' }],
        },
      },
    }
    await fs.writeFile(
      path.join(tmpDir, '.dqa', 'schemas', 'test-v3.yaml'),
      yaml.dump(v3Schema),
    )
    const result = await loadWorkflow('test-v3', tmpDir)
    expect(result._version).toBe(3)
    if (result._version === 3) {
      expect(result.name).toBe('test-v3')
      expect(result.pipeline).toHaveLength(1)
      expect(result.phases['phase-a'].tasks).toHaveLength(1)
    }
  })

  it('still loads v2 YAML files (backward compat)', async () => {
    const v2Schema = {
      name: 'test-v2',
      tasks: [
        { id: 'a', description: 'Task A', outputPath: 'a.md', dependencies: [] },
      ],
    }
    await fs.writeFile(
      path.join(tmpDir, '.dqa', 'schemas', 'test-v2.yaml'),
      yaml.dump(v2Schema),
    )
    const result = await loadWorkflow('test-v2', tmpDir)
    expect(result._version).toBe(2)
    if (result._version === 2) {
      expect(result.name).toBe('test-v2')
      expect(result.tasks).toHaveLength(1)
    }
  })

  it('loads v3 workflow from .dqa/workflows/ directory', async () => {
    await fs.mkdirp(path.join(tmpDir, '.dqa', 'workflows'))
    const v3Schema = {
      name: 'test-v3',
      version: 1,
      pipeline: [{ phase: 'p1' }],
      phases: {
        p1: {
          description: 'Phase 1',
          tasks: [
            { id: 'task-a', output: 'a.md', instruction: 'Do A' },
          ],
        },
      },
    }
    await fs.writeFile(
      path.join(tmpDir, '.dqa', 'workflows', 'test-v3.yaml'),
      yaml.dump(v3Schema),
    )
    const result = await loadWorkflow('test-v3', tmpDir)
    expect(result._version).toBe(3)
    if (result._version === 3) {
      expect(result.name).toBe('test-v3')
      expect(result.pipeline).toHaveLength(1)
    }
  })

  it('.dqa/workflows/ takes priority over .dqa/schemas/', async () => {
    await fs.mkdirp(path.join(tmpDir, '.dqa', 'workflows'))
    await fs.mkdirp(path.join(tmpDir, '.dqa', 'schemas'))

    // v3 in workflows/
    const v3Schema = {
      name: 'priority-test',
      version: 1,
      pipeline: [{ phase: 'p' }],
      phases: { p: { tasks: [{ id: 't', output: 't.md' }] } },
    }
    await fs.writeFile(
      path.join(tmpDir, '.dqa', 'workflows', 'priority-test.yaml'),
      yaml.dump(v3Schema),
    )

    // v2 with same name in schemas/
    const v2Schema = {
      name: 'priority-test',
      tasks: [{ id: 't', description: 't', outputPath: 't.md', dependencies: [] }],
    }
    await fs.writeFile(
      path.join(tmpDir, '.dqa', 'schemas', 'priority-test.yaml'),
      yaml.dump(v2Schema),
    )

    // Should load v3 (workflows/ has priority)
    const result = await loadWorkflow('priority-test', tmpDir)
    expect(result._version).toBe(3)
  })
})
