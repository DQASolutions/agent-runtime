import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { parseSkill } from './skill-frontmatter.js'
import { FieldSession } from './session.js'

describe('parseSkill', () => {
  it('extracts body + tools from frontmatter', () => {
    const r = parseSkill('---\nname: x\ntools: [reconDelta, emitCoDo]\n---\nĐiều tra rồi quyết.')
    expect(r.tools).toEqual(['reconDelta', 'emitCoDo'])
    expect(r.body).toBe('Điều tra rồi quyết.')
  })
  it('no frontmatter → whole text is the body, no tools', () => {
    const r = parseSkill('Chỉ là hướng dẫn.')
    expect(r.body).toBe('Chỉ là hướng dẫn.')
    expect(r.tools).toBeUndefined()
  })
  it('frontmatter without tools → body only', () => {
    expect(parseSkill('---\nname: x\n---\nbody').tools).toBeUndefined()
  })
  it('empty input → {}', () => {
    expect(parseSkill(undefined)).toEqual({})
  })
})

describe('FieldSession surfaces skill instruction + tools at an investigation step', () => {
  let appDir: string
  let workspace: string
  beforeEach(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-app-'))
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-ws-'))
    await fs.writeFile(path.join(appDir, 'ontology.yaml'), 'entities:\n  - name: GiaoDich\n    label: GD\n    properties:\n      - { name: category, type: text }\n')
    await fs.writeFile(path.join(appDir, 'workflow.yaml'), 'name: inv\nversion: 3\npipeline:\n  - phase: p\nphases:\n  p:\n    tasks:\n      - id: investigate\n        type: agent-task\n        depends: []\n')
    await fs.mkdirp(path.join(appDir, 'skills'))
    await fs.writeFile(path.join(appDir, 'skills', 'investigate.md'), '---\nname: investigate\ntools: [reconDelta, emitCoDo]\n---\nĐiều tra giao dịch bị flag rồi quyết.')
  })
  afterEach(async () => {
    await fs.remove(appDir)
    await fs.remove(workspace)
  })

  it('agent checkpoint carries the allowed tools + the playbook body', async () => {
    const s = await FieldSession.open({ appDir, workspace })
    const cp = await s.start('p1')
    expect(cp.status).toBe('agent')
    if (cp.status !== 'agent') return
    expect(cp.tools).toEqual(['reconDelta', 'emitCoDo'])
    expect(cp.instruction).toContain('Điều tra giao dịch bị flag')
  })
})
