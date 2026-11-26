/**
 * DI-07 — `dqa-context.json` shape + JSON Schema conformance.
 *
 * Spec mandate: every ingest run produces a single, API-spreadable
 * dqa-context.json with `version`, `generated`, `source_files[]`,
 * `content_blocks[]`, `stats{}`. Validate via JSON Schema.
 */

import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { Ajv } from 'ajv'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFolder } from './classifier.js'
import { ingest } from './packager.js'
import type { DqaContext } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'dqa-context.schema.json')

let tmpDir: string
let docsDir: string
let outDir: string
let stagedDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-ctx-'))
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

function compileValidator() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'))
  // The generated schema declares draft-07; the default Ajv export handles it.
  const ajv = new Ajv({ allErrors: true, strict: false })
  return ajv.compile(schema)
}

describe('dqa-context.json (DI-07)', () => {
  it('is emitted at <outDir>/dqa-context.json after every ingest', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), '# hello')
    const inputsPath = await writeInputs(docsDir)
    await ingest({ inputsPath, stagedDir, outDir })

    const contextPath = path.join(outDir, 'dqa-context.json')
    expect(fs.existsSync(contextPath)).toBe(true)
  })

  it('has the spec-mandated top-level shape', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), '# hello')
    fs.writeFileSync(path.join(docsDir, 'b.md'), 'b'.repeat(40))
    const inputsPath = await writeInputs(docsDir)
    await ingest({ inputsPath, stagedDir, outDir })

    const ctx = JSON.parse(
      fs.readFileSync(path.join(outDir, 'dqa-context.json'), 'utf-8'),
    ) as DqaContext

    expect(ctx.version).toBe('3.0')
    expect(ctx.generated).toBeTypeOf('string')
    expect(Array.isArray(ctx.source_files)).toBe(true)
    expect(Array.isArray(ctx.content_blocks)).toBe(true)
    expect(typeof ctx.stats).toBe('object')
    expect(ctx.source_files).toHaveLength(2)
    expect(ctx.stats.file_count).toBe(2)
  })

  it('block_range exactly slices the consolidated content_blocks', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'first')
    fs.writeFileSync(path.join(docsDir, 'b.md'), 'second')
    const inputsPath = await writeInputs(docsDir)
    await ingest({ inputsPath, stagedDir, outDir })

    const ctx = JSON.parse(
      fs.readFileSync(path.join(outDir, 'dqa-context.json'), 'utf-8'),
    ) as DqaContext

    // Every range must be in-bounds and non-overlapping
    let lastEnd = 0
    for (const sf of ctx.source_files) {
      expect(sf.block_range.start).toBe(lastEnd)
      expect(sf.block_range.end).toBeGreaterThanOrEqual(sf.block_range.start)
      expect(sf.block_range.end - sf.block_range.start).toBe(sf.stats.total_blocks)
      lastEnd = sf.block_range.end
    }
    expect(lastEnd).toBe(ctx.content_blocks.length)
  })

  it('content_blocks shape is API-spreadable (text|image|document with required fields)', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), '# hello')
    // PNG header, payload irrelevant
    fs.writeFileSync(
      path.join(docsDir, 'pic.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    const inputsPath = await writeInputs(docsDir)
    await ingest({ inputsPath, stagedDir, outDir })

    const ctx = JSON.parse(
      fs.readFileSync(path.join(outDir, 'dqa-context.json'), 'utf-8'),
    ) as DqaContext

    for (const block of ctx.content_blocks) {
      if (block.type === 'text') {
        expect(typeof block.text).toBe('string')
      } else if (block.type === 'image' || block.type === 'document') {
        expect(block.source.type).toBe('base64')
        expect(typeof block.source.media_type).toBe('string')
        expect(typeof block.source.data).toBe('string')
      } else {
        // Catch-all: block.type should never be anything else
        expect(true).toBe(false)
      }
    }
  })

  it('passes JSON Schema validation (ajv) — DI-07 spec verification', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'hello world')
    fs.writeFileSync(
      path.join(docsDir, 'pic.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    const inputsPath = await writeInputs(docsDir)
    await ingest({ inputsPath, stagedDir, outDir })

    const ctx = JSON.parse(fs.readFileSync(path.join(outDir, 'dqa-context.json'), 'utf-8'))
    const validate = compileValidator()
    const ok = validate(ctx)
    if (!ok) {
      // surface ajv's diagnostic when the assertion fails
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2))
    }
    expect(ok).toBe(true)
  })

  it('budget_warnings is always present (empty array under safe defaults)', async () => {
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'x')
    const inputsPath = await writeInputs(docsDir)
    await ingest({ inputsPath, stagedDir, outDir })

    const ctx = JSON.parse(
      fs.readFileSync(path.join(outDir, 'dqa-context.json'), 'utf-8'),
    ) as DqaContext
    expect(Array.isArray(ctx.budget_warnings)).toBe(true)
    expect(ctx.budget_warnings).toEqual([])
  })

  it('reflects budget warnings raised during ingest', async () => {
    fs.writeFileSync(
      path.join(docsDir, 'a.md'),
      'some text that turns into more than one token when divided by four',
    )
    const inputsPath = await writeInputs(docsDir)
    await ingest({
      inputsPath,
      stagedDir,
      outDir,
      budget: { maxTokens: 1, maxImages: 100 },
    })

    const ctx = JSON.parse(
      fs.readFileSync(path.join(outDir, 'dqa-context.json'), 'utf-8'),
    ) as DqaContext
    expect(ctx.budget_warnings.some(w => w.kind === 'tokens')).toBe(true)
  })
})
