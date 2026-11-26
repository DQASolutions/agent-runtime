import fs from 'fs-extra'
import path from 'node:path'
import yaml from 'js-yaml'
import { scanFolder } from './classifier.js'
import { convertToPdf } from './office.js'
import { handleMarkdown } from './markdown.js'
import { handleImage, handlePdf, handleText } from './native.js'
import type {
  BlockProvenance,
  ClassifiedFile,
  ContentBlock,
  ContextPackage,
  DqaContext,
  DqaContextSourceFile,
  ImageCounter,
  InputsFile,
  Manifest,
  ManifestBudgetWarning,
  ManifestEntry,
} from './types.js'
import { handleXlsx } from './xlsx-pipeline.js'
import {
  DEFAULT_INGEST_MAX_IMAGES,
  DEFAULT_INGEST_MAX_TOKENS,
  estimateTokens,
  evaluateIngestBudget,
  type BudgetOptions,
} from './budget.js'

export interface IngestFolderOptions {
  /** Folder of mixed-format source files to ingest. */
  folder: string
  /** Output directory; receives inputs.yml, _staged/, per-file dirs,
   *  manifest.json and the consolidated dqa-context.json. */
  outDir: string
  budget?: Partial<BudgetOptions>
}

export interface IngestFolderResult {
  manifest: Manifest
  /** Absolute path to the consolidated, API-spreadable dqa-context.json. */
  contextPath: string
  /** Number of source files skipped as unsupported. */
  skipped: number
}

export interface IngestOptions {
  inputsPath: string
  stagedDir: string
  outDir: string
  /**
   * Budget thresholds enforced inline. When omitted, the defaults
   * (180k tokens / 100 images) are applied — these track Anthropic's
   * context window and per-request image limit. Crossing a threshold
   * pushes a warning into the returned Manifest.budget_warnings; the
   * ingest still completes.
   */
  budget?: Partial<BudgetOptions>
}

async function ingestOne(
  file: ClassifiedFile,
  counter: ImageCounter,
  stagedDir: string,
  perFileDir: string,
): Promise<{
  blocks: ContentBlock[]
  provenance?: BlockProvenance[]
  imageCount: number
  warnings: string[]
  sourceFile: string
}> {
  const imagesDir = path.join(perFileDir, 'images')
  fs.mkdirpSync(imagesDir)
  const warnings: string[] = []

  switch (file.track) {
    case 'native-pdf':
      return {
        blocks: handlePdf(file.path),
        imageCount: 0,
        warnings,
        sourceFile: file.path,
      }
    case 'native-image': {
      const before = counter.next
      const blocks = handleImage(file.path, counter, imagesDir)
      return {
        blocks,
        imageCount: counter.next - before,
        warnings,
        sourceFile: file.path,
      }
    }
    case 'native-text':
      // Markdown files get a section-level split with provenance (v3.1);
      // other text formats (.txt, .csv, .json, .yaml, .yml) keep the
      // single-block whole-file embedding that handleText emits.
      if (file.extension === '.md') {
        const { blocks, provenance } = handleMarkdown(file.path)
        return {
          blocks,
          provenance,
          imageCount: 0,
          warnings,
          sourceFile: file.path,
        }
      }
      return {
        blocks: handleText(file.path),
        imageCount: 0,
        warnings,
        sourceFile: file.path,
      }
    case 'office': {
      const pdfPath = path.join(stagedDir, `${file.kebabName}.pdf`)
      if (!fs.existsSync(pdfPath)) {
        warnings.push(`staged PDF missing for ${file.path} — running LibreOffice on demand`)
        convertToPdf(file.path, stagedDir)
      }
      return {
        blocks: handlePdf(pdfPath),
        imageCount: 0,
        warnings,
        sourceFile: file.path,
      }
    }
    case 'xlsx': {
      const result = await handleXlsx(file.path, counter, imagesDir)
      return {
        blocks: result.blocks,
        imageCount: result.imageCount,
        warnings: result.warnings,
        sourceFile: file.path,
      }
    }
    default:
      throw new Error(`Unknown track for ${file.path}`)
  }
}

/**
 * Top-level ingester: reads the classifier's inputs.yml, runs per-track
 * handlers, writes a context.json per source file, aggregates totals,
 * evaluates inline budget warnings, and returns a manifest.
 */
export async function ingest(opts: IngestOptions): Promise<Manifest> {
  const inputsRaw = yaml.load(fs.readFileSync(opts.inputsPath, 'utf-8')) as InputsFile
  fs.mkdirpSync(opts.outDir)

  const counter: ImageCounter = { next: 1 }
  const entries: ManifestEntry[] = []
  const consolidatedBlocks: ContentBlock[] = []
  const consolidatedSources: DqaContextSourceFile[] = []
  let totalTokens = 0
  let totalImages = 0
  let totalBlocks = 0

  for (const file of inputsRaw.files) {
    const perFileDir = path.join(opts.outDir, file.kebabName)
    fs.mkdirpSync(perFileDir)
    const imagesDir = path.join(perFileDir, 'images')
    fs.mkdirpSync(imagesDir)

    const { blocks, provenance, imageCount, warnings, sourceFile } = await ingestOne(
      file,
      counter,
      opts.stagedDir,
      perFileDir,
    )

    const tokens = estimateTokens(blocks)
    const pkg: ContextPackage = {
      version: provenance ? '3.1' : '3.0',
      generated: new Date().toISOString(),
      source_file: sourceFile,
      image_directory: path.resolve(imagesDir),
      content_blocks: blocks,
      ...(provenance ? { block_provenance: provenance } : {}),
      stats: {
        total_blocks: blocks.length,
        estimated_tokens: tokens,
        image_count: imageCount,
      },
      ...(warnings.length ? { warnings } : {}),
    }
    const contextFile = path.join(perFileDir, 'context.json')
    fs.writeFileSync(contextFile, JSON.stringify(pkg, null, 2))

    entries.push({
      source: sourceFile,
      output_dir: perFileDir,
      context_file: contextFile,
      image_directory: path.resolve(imagesDir),
      stats: pkg.stats,
      ...(warnings.length ? { warnings } : {}),
    })

    // Track block range in the consolidated array so downstream tools can
    // locate which source produced each slice without re-walking files.
    const start = consolidatedBlocks.length
    consolidatedBlocks.push(...blocks)
    consolidatedSources.push({
      path: sourceFile,
      kebab_name: file.kebabName,
      track: file.track!,
      stats: pkg.stats,
      block_range: { start, end: consolidatedBlocks.length },
      ...(warnings.length ? { warnings } : {}),
    })

    totalTokens += tokens
    totalImages += imageCount
    totalBlocks += blocks.length
  }

  const limits = {
    maxTokens: opts.budget?.maxTokens ?? DEFAULT_INGEST_MAX_TOKENS,
    maxImages: opts.budget?.maxImages ?? DEFAULT_INGEST_MAX_IMAGES,
  }
  const budgetWarnings: ManifestBudgetWarning[] = evaluateIngestBudget(
    { tokens: totalTokens, images: totalImages },
    limits,
  )

  const manifest: Manifest = {
    version: '3.0',
    generated: new Date().toISOString(),
    files: entries,
    totals: {
      total_tokens: totalTokens,
      total_images: totalImages,
      total_blocks: totalBlocks,
    },
    budget_warnings: budgetWarnings,
  }
  fs.writeFileSync(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // DI-07 — consolidated, API-spreadable single artifact. Authoritative
  // shape lives in schemas/dqa-context.schema.json (JSON Schema, draft-07).
  const dqaContext: DqaContext = {
    version: '3.0',
    generated: manifest.generated,
    source_files: consolidatedSources,
    content_blocks: consolidatedBlocks,
    stats: {
      total_blocks: totalBlocks,
      total_tokens: totalTokens,
      total_images: totalImages,
      file_count: consolidatedSources.length,
    },
    budget_warnings: budgetWarnings,
  }
  fs.writeFileSync(path.join(opts.outDir, 'dqa-context.json'), JSON.stringify(dqaContext, null, 2))

  return manifest
}

/**
 * One-shot folder ingester — the same pipeline the `dqa ingest` CLI runs:
 * scan (classify) → stage office→PDF → ingest per track. Wraps scanFolder +
 * convertOfficeBatch + ingest so callers (the CLI, the `read-sources` workflow
 * executor) get `dqa-context.json` from a folder in a single call, without
 * re-implementing the inputs.yml / staging dance.
 *
 * Returns the manifest plus the absolute path to the consolidated context so a
 * downstream step can point an extractor skill at it.
 */
export async function ingestFolder(opts: IngestFolderOptions): Promise<IngestFolderResult> {
  const outDir = path.resolve(opts.outDir)
  const inputsPath = path.join(outDir, 'inputs.yml')
  const stagedDir = path.join(outDir, '_staged')
  fs.mkdirpSync(stagedDir)

  const inputs = await scanFolder(opts.folder, { needsConversionOnly: false })
  if (inputs.files.length === 0) {
    throw new Error(
      `No ingestable files found in ${opts.folder} (${inputs.skipped.length} skipped as unsupported).`,
    )
  }
  fs.writeFileSync(inputsPath, yaml.dump(inputs, { lineWidth: 120 }))

  if (inputs.files.some((f) => f.track === 'office')) convertOfficeBatch(inputsPath, stagedDir)

  const manifest = await ingest({
    inputsPath,
    stagedDir,
    outDir,
    ...(opts.budget ? { budget: opts.budget } : {}),
  })

  return { manifest, contextPath: path.join(outDir, 'dqa-context.json'), skipped: inputs.skipped.length }
}

/**
 * Convert all office-track files listed in inputs.yml to PDF in stagedDir.
 * Idempotent — skips files already present.
 */
export function convertOfficeBatch(inputsPath: string, stagedDir: string): string[] {
  const inputs = yaml.load(fs.readFileSync(inputsPath, 'utf-8')) as InputsFile
  fs.mkdirpSync(stagedDir)
  const produced: string[] = []
  for (const f of inputs.files) {
    if (f.track !== 'office') continue
    const pdfPath = path.join(stagedDir, `${f.kebabName}.pdf`)
    if (fs.existsSync(pdfPath)) {
      produced.push(pdfPath)
      continue
    }
    convertToPdf(f.path, stagedDir)
    // LibreOffice names output after source stem — rename to kebab for consistency.
    const stem = path.basename(f.path, path.extname(f.path))
    const raw = path.join(stagedDir, `${stem}.pdf`)
    if (raw !== pdfPath && fs.existsSync(raw)) fs.renameSync(raw, pdfPath)
    produced.push(pdfPath)
  }
  return produced
}
