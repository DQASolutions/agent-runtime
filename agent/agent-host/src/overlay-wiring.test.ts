// Wiring overlay end-to-end: manifest `overlays:` → FieldApp nạp app/overlays/<n>/functions
// CHỒNG lên base (override-by-id). Dựng một app tạm trên đĩa (không đụng app ke-toan thật).
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { FieldApp } from './field-app.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-wiring-'))
afterAll(() => fs.removeSync(tmp))

async function makeApp(overlays: string[]): Promise<string> {
  const dir = path.join(tmp, `app-${overlays.join('-') || 'base'}`)
  await fs.ensureDir(path.join(dir, 'functions'))
  await fs.writeFile(path.join(dir, 'ontology.yaml'), `entities:\n  - name: G\n    label: G\n    properties:\n      - { name: k, type: text }\n`)
  await fs.writeFile(
    path.join(dir, 'workflow.yaml'),
    `name: w\nversion: 3\npipeline:\n  - phase: p\nphases:\n  p:\n    tasks:\n      - id: ingest\n        type: agent-task\n        uses: ingest\n        depends: []\n      - id: check\n        type: agent-task\n        uses: check\n        with: { types: [G] }\n        outputs:\n          count: { type: number }\n        depends: [ingest]\n`,
  )
  await fs.writeFile(path.join(dir, 'app.yaml'), `name: t\nstorage:\n  adapter: memory\noverlays: [${overlays.join(', ')}]\n`)
  // base: R-A khớp k==='x'
  await fs.writeFile(path.join(dir, 'functions', 'base.js'), `export const a = { kind:'rule', on:'G', id:'R-A', khi: (g)=> g.data.k==='x' }\n`)
  // overlay demo: thay R-A (khớp 'y') + thêm R-C (khớp tất cả)
  if (overlays.includes('demo')) {
    await fs.ensureDir(path.join(dir, 'overlays', 'demo', 'functions'))
    await fs.writeFile(
      path.join(dir, 'overlays', 'demo', 'functions', 'o.js'),
      `export const a = { kind:'rule', on:'G', id:'R-A', khi: (g)=> g.data.k==='y' }\nexport const c = { kind:'rule', on:'G', id:'R-C', khi: ()=> true }\n`,
    )
  }
  return dir
}

const CASE = JSON.stringify({ instances: [{ type: 'G', props: { k: 'x' } }, { type: 'G', props: { k: 'y' } }] })

describe('FieldApp — wiring overlay qua manifest.overlays', () => {
  const count = (res: { exports: Record<string, unknown> }): number => (res.exports.check as { count: number }).count

  it('không overlay: chỉ luật base (R-A khớp x) → 1 cờ', async () => {
    const app = await FieldApp.load({ appDir: await makeApp([]) })
    expect(count(await app.run(CASE, { tenant: 'a', onGate: () => true }))).toBe(1)
  })

  it('có overlay demo: R-A bị THAY (khớp y, KHÔNG cộng dồn base) + R-C THÊM → count 3', async () => {
    // Nếu override SAI (base R-A 'x' và overlay R-A 'y' cùng sống) → count = 4 (2×R-A + 2×R-C).
    // Override ĐÚNG → chỉ 1 R-A (bản overlay, khớp 'y') + 2 R-C = 3.
    const app = await FieldApp.load({ appDir: await makeApp(['demo']) })
    expect(count(await app.run(CASE, { tenant: 'b', onGate: () => true }))).toBe(3)
  })
})
