// @dqa-ai-solutions/ingest-documents engine — public surface.

export { scanFolder, TRACKS, MIME, kebabize } from './classifier.js'
export { ingest, ingestFolder, convertOfficeBatch } from './packager.js'
export type { IngestOptions, IngestFolderOptions, IngestFolderResult } from './packager.js'
export { rebuildManifest } from './manifest.js'
export type { RebuildOptions } from './manifest.js'
export {
  ANTHROPIC_IMAGE_HARD_LIMIT,
  DEFAULT_INGEST_MAX_IMAGES,
  DEFAULT_INGEST_MAX_TOKENS,
  buildBudgetReport,
  estimateTokens,
  evaluateIngestBudget,
} from './budget.js'
export type {
  BudgetOptions,
  BudgetWarning,
  BudgetWarningKind,
} from './budget.js'
export { LibreOfficeMissingError, detectSoffice, convertToPdf } from './office.js'
export {
  handleMarkdown,
  ingestMarkdown,
  markdownToBlocks,
  splitMarkdownSections,
} from './markdown.js'
export * from './types.js'
// File-transport classifier (formerly `@dqa/shared`, folded in: only this package used it).
export {
  TRANSPORT_TRACKS,
  needsConversion,
  isTextReadable,
  readabilityOf,
  classifyTransport,
  type TransportTrack,
  type Readability,
} from './transport-classifier.js'
