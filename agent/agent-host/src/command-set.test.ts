import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { CommandSet } from './command-set.js'
import { writeGrant } from './grant.js'
import { readLedger } from './trace.js'

const ONTOLOGY = `
entities:
  - name: GiaoDich
    label: Giao dịch
    properties:
      - { name: category, type: text }
`
const FUNCTIONS = `
export const echoCat = { kind: 'compute', name: 'echoCat',
  body: async (args, _ctx, io) => { const g = await io.get(String(args.id)); return g ? g.data.category : null } }
export const greet = { kind: 'action', name: 'greet', effect: () => [{ type: 'greeted', aggregate: 'x' }] }
`

describe('CommandSet (governed command-set over an app ontology)', () => {
  let appDir: string
  let workspace: string

  beforeAll(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-app-'))
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ws-'))
    await fs.writeFile(path.join(appDir, 'ontology.yaml'), ONTOLOGY)
    await fs.mkdirp(path.join(appDir, 'functions'))
    await fs.writeFile(path.join(appDir, 'functions', 'mod.js'), FUNCTIONS)
  })
  afterAll(async () => {
    await fs.remove(appDir)
    await fs.remove(workspace)
  })

  it('act(createInstance) writes; query/get read it back', async () => {
    const cs = await CommandSet.open({ appDir, workspace, tenant: 'p1', actor: 'senior' })
    const ev = await cs.act('createInstance', { type: 'GiaoDich', props: { category: 'xăng' } })
    const id = ev[0].aggregate
    expect((await cs.query('GiaoDich')).length).toBe(1)
    expect((await cs.get(id))!.data.category).toBe('xăng')
  })

  it('call runs a bound compute against the stored instance', async () => {
    const cs = await CommandSet.open({ appDir, workspace, tenant: 'p2', actor: 'senior' })
    const ev = await cs.act('createInstance', { type: 'GiaoDich', props: { category: 'tiếp khách' } })
    expect(await cs.call('echoCat', { id: ev[0].aggregate })).toBe('tiếp khách')
  })

  it('act runs a bound custom action (emits events)', async () => {
    const cs = await CommandSet.open({ appDir, workspace, tenant: 'p3' })
    expect((await cs.act('greet', {})).map((e) => e.type)).toContain('greeted')
  })

  it('note appends a review entry to the tenant audit trail', async () => {
    const cs = await CommandSet.open({ appDir, workspace, tenant: 'p4', actor: 'senior' })
    await cs.note('g1', 'đã xem xét, hợp lệ')
    const file = path.join(workspace, '.dqa', 'projects', 'p4', 'review-notes.jsonl')
    const line = JSON.parse((await fs.readFile(file, 'utf-8')).trim())
    expect(line).toMatchObject({ id: 'g1', text: 'đã xem xét, hợp lệ', by: 'senior' })
  })

  // ── Step 2: hard write door ──────────────────────────────────────────────────

  it('an active grant ALLOWS an Action listed in tools', async () => {
    const tenantDir = path.join(workspace, '.dqa', 'projects', 'p5')
    await writeGrant(tenantDir, { task: 'investigate', tools: ['greet'], issuedAt: '2026-01-01T00:00:00.000Z' })
    const cs = await CommandSet.open({ appDir, workspace, tenant: 'p5', actor: 'senior' })
    expect((await cs.act('greet', {})).map((e) => e.type)).toContain('greeted')
  })

  it('an active grant DENIES an Action not in tools, and records it to the ledger', async () => {
    const tenantDir = path.join(workspace, '.dqa', 'projects', 'p6')
    await writeGrant(tenantDir, { task: 'investigate', tools: ['greet'], issuedAt: '2026-01-01T00:00:00.000Z' })
    const cs = await CommandSet.open({ appDir, workspace, tenant: 'p6', actor: 'senior' })

    await expect(cs.act('createInstance', { type: 'GiaoDich', props: { category: 'xăng' } })).rejects.toThrow(
      /not in the granted capabilities/,
    )
    // nothing was written
    expect((await cs.query('GiaoDich')).length).toBe(0)
    // the denial is on the audit ledger
    const denied = (await readLedger(tenantDir)).filter((e) => e.kind === 'denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ name: 'createInstance', task: 'investigate', actor: 'senior' })
  })
})
