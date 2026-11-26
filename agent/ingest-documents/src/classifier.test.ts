import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { kebabize, scanFolder } from './classifier.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-classify-'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

describe('kebabize', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(kebabize('Create New User')).toBe('create-new-user')
  })

  it('collapses runs of non-alphanumerics', () => {
    expect(kebabize('Payment__Integration--RFP!!')).toBe('payment-integration-rfp')
  })

  it('trims leading/trailing hyphens', () => {
    expect(kebabize('--Foo--')).toBe('foo')
  })
})

describe('scanFolder', () => {
  it('classifies files by extension into tracks', async () => {
    await fs.writeFile(path.join(tmpDir, 'spec.pdf'), 'x')
    await fs.writeFile(path.join(tmpDir, 'notes.md'), 'x')
    await fs.writeFile(path.join(tmpDir, 'book.xlsx'), 'x')
    await fs.writeFile(path.join(tmpDir, 'deck.pptx'), 'x')
    await fs.writeFile(path.join(tmpDir, 'photo.PNG'), 'x')

    const result = await scanFolder(tmpDir)
    const byName = Object.fromEntries(result.files.map((f) => [path.basename(f.path), f.track]))
    expect(byName).toEqual({
      'spec.pdf': 'native-pdf',
      'notes.md': 'native-text',
      'book.xlsx': 'xlsx',
      'deck.pptx': 'office',
      'photo.PNG': 'native-image',
    })
    expect(result.skipped).toHaveLength(0)
  })

  it('records unsupported extensions in skipped', async () => {
    await fs.writeFile(path.join(tmpDir, 'binary.exe'), 'x')
    await fs.writeFile(path.join(tmpDir, 'readme.md'), 'x')

    const result = await scanFolder(tmpDir)
    expect(result.files.map((f) => path.basename(f.path))).toEqual(['readme.md'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].extension).toBe('.exe')
  })

  it('walks subdirectories recursively', async () => {
    await fs.mkdirp(path.join(tmpDir, 'sub', 'deeper'))
    await fs.writeFile(path.join(tmpDir, 'top.md'), 'x')
    await fs.writeFile(path.join(tmpDir, 'sub', 'mid.md'), 'x')
    await fs.writeFile(path.join(tmpDir, 'sub', 'deeper', 'leaf.md'), 'x')

    const result = await scanFolder(tmpDir)
    expect(result.files.map((f) => path.basename(f.path)).sort()).toEqual([
      'leaf.md',
      'mid.md',
      'top.md',
    ])
  })

  it('disambiguates colliding kebab-names with numeric suffix', async () => {
    await fs.mkdirp(path.join(tmpDir, 'a'))
    await fs.mkdirp(path.join(tmpDir, 'b'))
    await fs.writeFile(path.join(tmpDir, 'a', 'Create New User.md'), 'x')
    await fs.writeFile(path.join(tmpDir, 'b', 'create-new-user.md'), 'x')

    const result = await scanFolder(tmpDir)
    const names = result.files.map((f) => f.kebabName).sort()
    expect(names).toEqual(['create-new-user', 'create-new-user-2'])
  })

  it('with needsConversionOnly keeps only office + xlsx files', async () => {
    await fs.writeFile(path.join(tmpDir, 'spec.pdf'), 'x')
    await fs.writeFile(path.join(tmpDir, 'notes.md'), 'x')
    await fs.writeFile(path.join(tmpDir, 'book.xlsx'), 'x')
    await fs.writeFile(path.join(tmpDir, 'deck.pptx'), 'x')
    await fs.writeFile(path.join(tmpDir, 'photo.png'), 'x')

    const result = await scanFolder(tmpDir, { needsConversionOnly: true })
    expect(result.files.map((f) => path.basename(f.path)).sort()).toEqual([
      'book.xlsx',
      'deck.pptx',
    ])
  })
})
