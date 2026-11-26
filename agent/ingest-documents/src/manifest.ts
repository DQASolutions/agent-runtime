import fs from 'fs-extra'
import path from 'node:path'
import {
  DEFAULT_INGEST_MAX_IMAGES,
  DEFAULT_INGEST_MAX_TOKENS,
  evaluateIngestBudget,
  type BudgetOptions,
} from './budget.js'
import type { Manifest, ManifestBudgetWarning, ManifestEntry } from './types.js'

export interface RebuildOptions {
  budget?: Partial<BudgetOptions>
}

/**
 * Regenerate manifest.json by scanning an already-populated dqa-ingested
 * root. Used by the `manifest` CLI subcommand as a standalone step so
 * tests or manual edits can re-index without re-running the whole ingest.
 *
 * Re-evaluates budget against per-file context.json stats so a manifest
 * rebuilt after manual edits still surfaces token/image overflows.
 */
export function rebuildManifest(rootDir: string, opts: RebuildOptions = {}): Manifest {
  const entries: ManifestEntry[] = []
  let totalTokens = 0
  let totalImages = 0
  let totalBlocks = 0
  for (const dirent of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const perFileDir = path.join(rootDir, dirent.name)
    const contextFile = path.join(perFileDir, 'context.json')
    if (!fs.existsSync(contextFile)) continue
    const pkg = JSON.parse(fs.readFileSync(contextFile, 'utf-8'))
    entries.push({
      source: pkg.source_file,
      output_dir: perFileDir,
      context_file: contextFile,
      image_directory: pkg.image_directory,
      stats: pkg.stats,
      ...(pkg.warnings?.length ? { warnings: pkg.warnings } : {}),
    })
    totalTokens += pkg.stats?.estimated_tokens ?? 0
    totalImages += pkg.stats?.image_count ?? 0
    totalBlocks += pkg.stats?.total_blocks ?? 0
  }
  const limits = {
    maxTokens: opts.budget?.maxTokens ?? DEFAULT_INGEST_MAX_TOKENS,
    maxImages: opts.budget?.maxImages ?? DEFAULT_INGEST_MAX_IMAGES,
  }
  const budgetWarnings: ManifestBudgetWarning[] = evaluateIngestBudget(
    { tokens: totalTokens, images: totalImages },
    limits,
  )
  return {
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
}
