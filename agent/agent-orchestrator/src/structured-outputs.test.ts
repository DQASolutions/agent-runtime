import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import type { WorkflowV3 } from './schema-types-v3.js'
import { loadState } from './state-manager.js'
import { validateOutputs } from './output-schema.js'
import type { OutputsDecl } from './schema-types-v3.js'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'

let tmpDir: string
let projectDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-outputs-'))
  projectDir = path.join(tmpDir, '.dqa', 'projects', 'p')
  await fs.mkdirp(projectDir)
})
afterEach(async () => {
  await fs.remove(tmpDir)
})

const orch = () => new Orchestrator(tmpDir, 'p', wf)

const wf: WorkflowV3 = {
  name: 'extract-flow',
  version: 3,
  pipeline: [{ phase: 'p' }],
  phases: {
    p: {
      tasks: [
        {
          id: 'extract',
          type: 'agent-task',
          output: 'extract.md',
          depends: [],
          instruction: 'extract',
          outputs: {
            vendor: { type: 'string' },
            amount: { type: 'number' },
            risk: { type: 'enum', values: ['low', 'high'] },
          },
        },
        {
          id: 'review',
          type: 'agent-task',
          output: 'review.md',
          depends: ['extract'],
          when: "extract.risk == 'high'",
          instruction: 'review',
        },
      ],
    },
  },
}

async function writeOutput(name: string, body = 'content', frontmatter?: Record<string, unknown>) {
  const fm = frontmatter
    ? `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`
    : ''
  await fs.writeFile(path.join(projectDir, name), fm + body)
}

// ── Pure validator ──────────────────────────────────────────────────────────

describe('validateOutputs', () => {
  const decl: OutputsDecl = {
    vendor: { type: 'string' },
    amount: { type: 'number' },
    risk: { type: 'enum', values: ['low', 'high'] },
    note: { type: 'string', optional: true },
  }

  it('accepts well-typed values', () => {
    const r = validateOutputs(decl, { vendor: 'ACME', amount: 25_000_000, risk: 'high' }, 'extract')
    expect(r.ok).toBe(true)
    expect(r.values).toEqual({ vendor: 'ACME', amount: 25_000_000, risk: 'high' })
  })

  it('flags missing required + wrong type + bad enum', () => {
    const r = validateOutputs(decl, { amount: 'lots', risk: 'medium' }, 'extract')
    expect(r.ok).toBe(false)
    const paths = r.errors.map((e) => e.path).sort()
    expect(paths).toEqual(['amount', 'risk', 'vendor'])
  })

  it('reads values from a <stepId> namespace too', () => {
    const r = validateOutputs(decl, { extract: { vendor: 'X', amount: 1, risk: 'low' } }, 'extract')
    expect(r.ok).toBe(true)
    expect(r.values.amount).toBe(1)
  })

  it('validates nested object + array specs', () => {
    const nested: OutputsDecl = {
      finding: { type: 'object', fields: { severity: { type: 'enum', values: ['low', 'high'] }, score: { type: 'number' } } },
      tags: { type: 'array', items: { type: 'string' } },
    }
    const ok = validateOutputs(nested, { finding: { severity: 'high', score: 9 }, tags: ['a', 'b'] }, 's')
    expect(ok.ok).toBe(true)
    const bad = validateOutputs(nested, { finding: { severity: 'nope', score: 'x' }, tags: ['a', 2] }, 's')
    expect(bad.ok).toBe(false)
    expect(bad.errors.map((e) => e.path).sort()).toEqual(['finding.score', 'finding.severity', 'tags[1]'])
  })
})

// ── End-to-end via the orchestrator ──────────────────────────────────────────

describe('orchestrator structured outputs', () => {
  it('captures + stores declared outputs from --exports', async () => {
    const o = orch()
    await o.start()
    await writeOutput('extract.md')
    await o.done('extract', { exports: { vendor: 'ACME', amount: 25_000_000, risk: 'high' } })

    const state = await loadState(path.join(tmpDir, '.dqa', 'state', 'p'))
    expect(state.outputs.extract).toEqual({ vendor: 'ACME', amount: 25_000_000, risk: 'high' })
    // mirrored into the exports namespace for expression resolution
    expect((state.exports.extract as Record<string, unknown>).amount).toBe(25_000_000)
  })

  it('sources declared outputs from output-file frontmatter (no --exports)', async () => {
    const o = orch()
    await o.start()
    await writeOutput('extract.md', 'body', { vendor: 'ACME', amount: 5, risk: 'low' })
    await o.done('extract')

    const state = await loadState(path.join(tmpDir, '.dqa', 'state', 'p'))
    expect(state.outputs.extract).toEqual({ vendor: 'ACME', amount: 5, risk: 'low' })
  })

  it('rejects done when a declared output is missing / mistyped', async () => {
    const o = orch()
    await o.start()
    await writeOutput('extract.md')
    await expect(o.done('extract', { exports: { vendor: 'ACME' } })).rejects.toThrow(/amount|risk/)
  })

  it('drives when: branching on a captured output (high → review runs)', async () => {
    const o = orch()
    await o.start()
    await writeOutput('extract.md')
    const next = await o.done('extract', { exports: { vendor: 'ACME', amount: 1, risk: 'high' } })
    expect(next.status).toBe('next')
    if (next.status === 'next') expect(next.task).toBe('review')
  })

  it('drives when: branching on a captured output (low → review skipped → complete)', async () => {
    const o = orch()
    await o.start()
    await writeOutput('extract.md')
    const next = await o.done('extract', { exports: { vendor: 'ACME', amount: 1, risk: 'low' } })
    expect(next.status).toBe('complete')
  })
})
