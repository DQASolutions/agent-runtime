import type { TransportTrack } from './transport-classifier.js'

/**
 * Transport track for an ingested file — alias of the framework-shared
 * {@link TransportTrack}. The canonical extension→format taxonomy lives in
 * `./transport-classifier.ts` (formerly `@dqa/shared`) so document-ingestion, spec-validate/onboard and test-onboard
 * all classify against one map (ADR-0002 Amendment 2).
 */
export type Track = TransportTrack

export interface ClassifiedFile {
  path: string
  track: Track | null
  kebabName: string
  extension: string
}

export interface InputsFile {
  sourceFolder: string
  files: ClassifiedFile[]
  skipped: { path: string; extension: string; reason: string }[]
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export interface DocumentBlock {
  type: 'document'
  source: { type: 'base64'; media_type: string; data: string }
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock

/**
 * Per-block source locator (ContextPackage v3.1, ADR-0002 §6).
 *
 * Stored in a parallel array on ContextPackage so the `content_blocks`
 * array stays API-shaped — Anthropic's content-blocks schema rejects
 * unknown fields, so DQA-only provenance lives next to them, not inside.
 *
 * All fields optional: an empty `{}` is valid and means "no specific
 * locator known" (typical for synthetic header blocks).
 */
export interface BlockProvenance {
  /** Source line range, 1-indexed inclusive (markdown, text). */
  lines?: [number, number]
  /** Source page number (PDF). */
  page?: number
  /** Source sheet name (XLSX). */
  sheet?: string
  /** Source row range, 1-indexed inclusive (XLSX). */
  rows?: [number, number]
  /** Heading text for markdown sections — surfaces in citation reports. */
  heading?: string
}

export interface ContextPackage {
  version: '3.0' | '3.1'
  generated: string
  source_file: string
  image_directory: string
  content_blocks: ContentBlock[]
  /**
   * v3.1+: per-block source locator. Length matches `content_blocks`.
   * Absent on v3.0 packages. Consumers must tolerate both shapes.
   */
  block_provenance?: BlockProvenance[]
  stats: {
    total_blocks: number
    estimated_tokens: number
    image_count: number
  }
  warnings?: string[]
}

export interface ManifestEntry {
  source: string
  output_dir: string
  context_file: string
  image_directory: string
  stats: ContextPackage['stats']
  warnings?: string[]
}

export interface ManifestBudgetWarning {
  kind: 'tokens' | 'images-anthropic-limit' | 'images-user-budget'
  total: number
  limit: number
  message: string
}

export interface Manifest {
  version: '3.0'
  generated: string
  files: ManifestEntry[]
  /**
   * Aggregate counters across all ingested files. `total_tokens` is the
   * sum of `estimated_tokens` per source; `total_images` the sum of
   * `image_count`. Useful for downstream tooling that needs to plan
   * against Anthropic's 200k-context / 100-image limits without re-walking
   * every per-file context.json.
   */
  totals: {
    total_tokens: number
    total_images: number
    total_blocks: number
  }
  /**
   * Inline budget warnings raised during ingest (token or image overflow).
   * Empty when limits were respected. The CLI also logs these to stderr.
   */
  budget_warnings: ManifestBudgetWarning[]
}

export interface ImageCounter {
  next: number
}

export interface NaturalSize {
  width: number
  height: number
}

/**
 * Consolidated single-file output written at `<outDir>/dqa-context.json`.
 *
 * Designed to be spread directly into `messages.create({ content: [...]})`
 * — `content_blocks` is the flat, API-shaped array.
 *
 * `source_files[].block_range` lets downstream tooling locate which source
 * file produced which slice of `content_blocks` without re-walking per-
 * file context.json files. Range is half-open: blocks [start, end).
 */
export interface DqaContextSourceFile {
  path: string
  kebab_name: string
  track: Track
  stats: ContextPackage['stats']
  block_range: { start: number; end: number }
  warnings?: string[]
}

export interface DqaContext {
  version: '3.0'
  generated: string
  source_files: DqaContextSourceFile[]
  content_blocks: ContentBlock[]
  stats: {
    total_blocks: number
    total_tokens: number
    total_images: number
    file_count: number
  }
  budget_warnings: ManifestBudgetWarning[]
}
