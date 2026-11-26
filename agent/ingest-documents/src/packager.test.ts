import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFolder } from './classifier.js'
import { ingest } from './packager.js'
import { rebuildManifest } from './manifest.js'
import type { ContextPackage, InputsFile } from './types.js'

let tmpDir: string
let docsDir: string
let outDir: string
let stagedDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-pack-'))
  docsDir = path.join(tmpDir, 'docs')
  outDir = path.join(tmpDir, 'out')
  stagedDir = path.join(tmpDir, 'staged')
  fs.mkdirpSync(docsDir)
  fs.mkdirpSync(stagedDir)
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

async function writeInputs(folder: string): Promise<string> {
  const inputs = await scanFolder(folder)
  const inputsPath = path.join(tmpDir, 'inputs.yml')
  fs.writeFileSync(inputsPath, yaml.dump(inputs))
  return inputsPath
}

describe('ingest end-to-end', () => {
  it('produces per-file context.json + manifest for mixed inputs', async () => {
    // text
    fs.writeFileSync(path.join(docsDir, 'notes.md'), '# Notes\nsome text')
    // standalone image (PNG header bytes, payload irrelevant)
    fs.writeFileSync(
      path.join(docsDir, 'photo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    // xlsx
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Name', 'Email'],
        ['Alice', 'a@x.com'],
      ]),
      'Users',
    )
    XLSX.writeFile(wb, path.join(docsDir, 'Create New User.xlsx'))

    const inputsPath = await writeInputs(docsDir)
    const manifest = await ingest({ inputsPath, stagedDir, outDir })

    expect(manifest.files).toHaveLength(3)

    // Every file has its own directory with context.json
    for (const f of manifest.files) {
      expect(fs.existsSync(f.context_file)).toBe(true)
      expect(fs.existsSync(f.image_directory)).toBe(true)
      const pkg = JSON.parse(fs.readFileSync(f.context_file, 'utf-8')) as ContextPackage
      // Markdown ingestion produces v3.1 (per-block provenance, ADR-0002 §6).
      // Other tracks remain on v3.0 until they emit block_provenance too.
      if (f.source.endsWith('.md')) {
        expect(pkg.version).toBe('3.1')
        expect(pkg.block_provenance).toBeDefined()
        expect(pkg.block_provenance!.length).toBe(pkg.content_blocks.length)
      } else {
        expect(pkg.version).toBe('3.0')
        expect(pkg.block_provenance).toBeUndefined()
      }
      expect(pkg.content_blocks.length).toBeGreaterThan(0)
    }

    // Image track produced a kebab-named image in the per-file images dir
    const imgEntry = manifest.files.find((f) => f.source.endsWith('photo.png'))!
    expect(fs.readdirSync(imgEntry.image_directory)).toContain('image-1-photo.png')

    // XLSX kebab-naming of output dir
    const xlsxEntry = manifest.files.find((f) => f.source.endsWith('.xlsx'))!
    expect(path.basename(xlsxEntry.output_dir)).toBe('create-new-user')

    // manifest.json written at out root
    expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(true)
  })

  it('gives every image a unique global IMAGE id across files', async () => {
    fs.writeFileSync(path.join(docsDir, 'one.png'), Buffer.from([0x89, 0x50]))
    fs.writeFileSync(path.join(docsDir, 'two.png'), Buffer.from([0x89, 0x50]))

    const inputsPath = await writeInputs(docsDir)
    const manifest = await ingest({ inputsPath, stagedDir, outDir })

    const allImages = manifest.files.flatMap((f) =>
      fs.readdirSync(f.image_directory).map((n) => n),
    )
    // Expect image-1-* and image-2-*, never two image-1-*
    const ids = allImages.map((n) => n.split('-').slice(0, 2).join('-'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(['image-1', 'image-2'])
  })

  it('manifest stats match per-file context.json stats', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'hello')
    const inputsPath = await writeInputs(docsDir)
    const manifest = await ingest({ inputsPath, stagedDir, outDir })

    const entry = manifest.files[0]
    const pkg = JSON.parse(fs.readFileSync(entry.context_file, 'utf-8')) as ContextPackage
    expect(entry.stats).toEqual(pkg.stats)
  })
})

describe('rebuildManifest', () => {
  it('regenerates manifest.json from an already-populated root', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'x')
    fs.writeFileSync(path.join(docsDir, 'b.md'), 'y')
    const inputsPath = await writeInputs(docsDir)
    await ingest({ inputsPath, stagedDir, outDir })

    // Delete the manifest, then rebuild.
    fs.removeSync(path.join(outDir, 'manifest.json'))
    const rebuilt = rebuildManifest(outDir)

    expect(rebuilt.files).toHaveLength(2)
    expect(rebuilt.files.every((f) => fs.existsSync(f.context_file))).toBe(true)
  })
})

describe('ingest budget gate (DI-05/DI-06)', () => {
  it('aggregates totals across files in the manifest', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'a'.repeat(40))
    fs.writeFileSync(path.join(docsDir, 'b.md'), 'b'.repeat(40))
    const inputsPath = await writeInputs(docsDir)
    const manifest = await ingest({ inputsPath, stagedDir, outDir })

    expect(manifest.totals.total_blocks).toBe(
      manifest.files.reduce((acc, f) => acc + f.stats.total_blocks, 0),
    )
    expect(manifest.totals.total_tokens).toBe(
      manifest.files.reduce((acc, f) => acc + f.stats.estimated_tokens, 0),
    )
    expect(manifest.totals.total_images).toBe(
      manifest.files.reduce((acc, f) => acc + f.stats.image_count, 0),
    )
  })

  it('emits no warnings under default thresholds for tiny inputs', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'small')
    const inputsPath = await writeInputs(docsDir)
    const manifest = await ingest({ inputsPath, stagedDir, outDir })
    expect(manifest.budget_warnings).toEqual([])
  })

  it('warns when caller-supplied token budget is crossed', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'hello world this is some content')
    const inputsPath = await writeInputs(docsDir)
    const manifest = await ingest({
      inputsPath,
      stagedDir,
      outDir,
      budget: { maxTokens: 1, maxImages: 100 },
    })
    expect(manifest.budget_warnings.some(w => w.kind === 'tokens')).toBe(true)
  })

  it('warns when caller-supplied image budget is crossed', async () => {
    fs.writeFileSync(path.join(docsDir, '1.png'), Buffer.from([0x89, 0x50]))
    fs.writeFileSync(path.join(docsDir, '2.png'), Buffer.from([0x89, 0x50]))
    const inputsPath = await writeInputs(docsDir)
    const manifest = await ingest({
      inputsPath,
      stagedDir,
      outDir,
      budget: { maxTokens: 1_000_000, maxImages: 1 },
    })
    expect(manifest.budget_warnings.some(w => w.kind === 'images-user-budget')).toBe(true)
  })
})
