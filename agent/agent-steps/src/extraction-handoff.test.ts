/**
 * The document → extractor → ingest handoff seams:
 *   - `read-sources` runs document-ingestion into the project base dir and
 *     exports the consolidated dqa-context.json path (document-ingestion's
 *     connect-point into the workflow).
 *   - `ingest` reads its payload from the file an upstream extractor skill wrote
 *     (`with.from`), and still accepts a pre-structured run input (back-compat).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import type { StepContext } from '@dqa-ai-solutions/agent-orchestrator'
import { createOntology, InMemoryAdapter } from '@dqa-ai-solutions/core-runtime'
import { GovernedOntologyPort } from '@dqa-ai-solutions/core-runtime'
import { loadOntology } from '@dqa-ai-solutions/core-runtime'
import { ingestExecutor, readSourcesExecutor } from './executors.js'

const ctx = { tenantId: 't1', actor: 'analyst' }
const prov = { source_ref: 'intake', confirmed_by: 'analyst', confirmed_at: '2026-06-01T00:00:00.000Z' }

const ontologyDecl = {
  entities: [
    { name: 'customer', label: 'Customer', properties: [{ name: 'name', type: 'text' as const }] },
    { name: 'account', label: 'Account', properties: [{ name: 'ref', type: 'text' as const }] },
  ],
  relationships: [{ name: 'owns', from: 'customer', to: 'account', cardinality: 'N..N' as const, directed: true }],
}

/** Build a StepContext with just the fields the executors read. */
function stepCtx(projectBaseDir: string, withParams: Record<string, unknown>, input?: string): StepContext {
  return {
    task: { with: withParams } as StepContext['task'],
    projectBaseDir,
    ...(input !== undefined ? { input } : {}),
  }
}

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-handoff-'))
})
afterEach(async () => {
  await fs.remove(tmp)
})

describe('read-sources executor', () => {
  it('ingests a source folder → dqa-context.json and exports its project-relative path', async () => {
    const sources = path.join(tmp, 'sources')
    await fs.mkdirp(sources)
    await fs.writeFile(path.join(sources, 'note.md'), '# KYC note\n\nShell Holdings Ltd owns account ACC-9001.\n')
    await fs.writeFile(path.join(sources, 'memo.txt'), 'Beneficial owner unclear.\n')

    const res = await readSourcesExecutor().run(stepCtx(tmp, { folder: 'sources', out: '_ingest' }))

    expect(res.exports?.context).toBe(path.join('_ingest', 'dqa-context.json'))
    expect(res.exports?.files).toBe(2)
    expect((res.exports?.tokens as number) > 0).toBe(true)

    const contextPath = path.join(tmp, res.exports!.context as string)
    expect(await fs.pathExists(contextPath)).toBe(true)
    const dqaContext = await fs.readJson(contextPath)
    expect(dqaContext.content_blocks.length).toBeGreaterThan(0)
  })
})

describe('ingest executor — payload source', () => {
  async function freshPort() {
    const ontology = createOntology({ adapter: new InMemoryAdapter() })
    const port = new GovernedOntologyPort(ontology, [])
    await loadOntology(port, ontologyDecl, ctx)
    return port
  }

  it('reads the structured payload an extractor wrote (with.from)', async () => {
    const port = await freshPort()
    const payload = {
      instances: [
        { type: 'customer', ref: 'c', props: { name: 'Shell Holdings Ltd' } },
        { type: 'account', ref: 'a', props: { ref: 'ACC-9001' } },
      ],
      links: [{ relationship: 'owns', from: 'c', to: 'a' }],
    }
    await fs.writeJson(path.join(tmp, 'extracted.json'), payload)

    const res = await ingestExecutor(port, ctx, prov).run(stepCtx(tmp, { from: 'extracted.json' }))

    expect(res.exports?.ingested).toBe(2)
    expect(await port.query({ type: 'customer' }, ctx)).toHaveLength(1)
    expect(await port.query({ type: 'account' }, ctx)).toHaveLength(1)
    // The `owns` link resolved the local refs: traversing it from the customer
    // reaches the account.
    const owned = await port.query({ type: 'customer', traverse: [{ relationship: 'owns', direction: 'out' }] }, ctx)
    expect(owned).toHaveLength(1)
  })

  it('still accepts a pre-structured run input (back-compat)', async () => {
    const port = await freshPort()
    const input = JSON.stringify({ instances: [{ type: 'customer', props: { name: 'Acme' } }] })

    const res = await ingestExecutor(port, ctx, prov).run(stepCtx(tmp, {}, input))

    expect(res.exports?.ingested).toBe(1)
    expect(await port.query({ type: 'customer' }, ctx)).toHaveLength(1)
  })

  it('rejects a malformed payload pre-flight and writes nothing (atomic)', async () => {
    const port = await freshPort()
    // Second instance has an unknown type — the whole payload must be refused
    // before the first (valid) instance is written.
    const input = JSON.stringify({
      instances: [
        { type: 'customer', props: { name: 'Good' } },
        { type: 'vendor', props: {} },
      ],
    })

    await expect(ingestExecutor(port, ctx, prov).run(stepCtx(tmp, {}, input))).rejects.toThrow(/UNKNOWN_ENTITY_TYPE/)
    // Atomic: the valid first instance was NOT written.
    expect(await port.query({ type: 'customer' }, ctx)).toHaveLength(0)
  })
})
