/**
 * Transport classifier — the single source of truth for "what kind of file
 * is this, and can it be consumed as-is or must it be converted first."
 *
 * TRANSPORT only: this answers extension → format track. It deliberately
 * knows nothing about whether a file is a *canonical* artifact of any domain
 * (a DQA story, a spec-linked test) — that DOMAIN check stays in the engine
 * that owns the domain. See docs/adr/ADR-0002 Amendment 2.
 *
 * Consumers: document-ingestion (scan), spec-validate/onboard, test-onboard,
 * standalone /dqa:ingest.
 *
 * Pure / sync / deterministic. No I/O, no LLM.
 */

import path from 'node:path'

/**
 * Transport track — an extension-derived file kind that drives converter /
 * parser routing.
 *
 *   native-text   UTF-8 readable; a deterministic CLI can open + inspect it
 *   native-pdf    PDF; Claude Code's Read tool consumes it directly
 *   native-image  raster image; Read tool consumes it directly
 *   office        .docx / .pptx (+ legacy .doc / .ppt); LibreOffice → PDF
 *   xlsx          .xlsx (+ legacy .xls); the spreadsheet pipeline
 */
export type TransportTrack =
  | 'native-text'
  | 'native-pdf'
  | 'native-image'
  | 'office'
  | 'xlsx'

/**
 * Lowercased extension (leading dot) → transport track. The one map every
 * onboarding / ingestion path classifies against — extend it here and every
 * consumer picks the new format up.
 */
export const TRANSPORT_TRACKS: Readonly<Record<string, TransportTrack>> = {
  '.txt': 'native-text',
  '.md': 'native-text',
  '.markdown': 'native-text',
  '.csv': 'native-text',
  '.json': 'native-text',
  '.yaml': 'native-text',
  '.yml': 'native-text',
  '.feature': 'native-text',
  '.pdf': 'native-pdf',
  '.png': 'native-image',
  '.jpg': 'native-image',
  '.jpeg': 'native-image',
  '.gif': 'native-image',
  '.webp': 'native-image',
  '.docx': 'office',
  '.pptx': 'office',
  '.doc': 'office',
  '.ppt': 'office',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
}

/**
 * Coarse readability verdict — the routing decision every onboard flow
 * needs: consume the file as-is, or route it through document-ingestion
 * conversion first.
 *
 *   readable          native-text / native-pdf / native-image
 *   needs-conversion  office / xlsx
 */
export type Readability = 'readable' | 'needs-conversion'

/** Tracks that MUST be converted by document-ingestion before consumption. */
export function needsConversion(track: TransportTrack): boolean {
  return track === 'office' || track === 'xlsx'
}

/**
 * Tracks a deterministic CLI can open and inspect as UTF-8 text. Only
 * `native-text`: a PDF or image is binary even though Claude Code can read
 * it natively.
 */
export function isTextReadable(track: TransportTrack): boolean {
  return track === 'native-text'
}

/** Coarse readability verdict for a track. */
export function readabilityOf(track: TransportTrack): Readability {
  return needsConversion(track) ? 'needs-conversion' : 'readable'
}

/**
 * Classify a file path by its extension. Returns `null` for an extension not
 * in {@link TRANSPORT_TRACKS} — the caller decides whether an unknown
 * extension is skipped silently or surfaced.
 */
export function classifyTransport(filePath: string): TransportTrack | null {
  const ext = path.extname(filePath).toLowerCase()
  return TRANSPORT_TRACKS[ext] ?? null
}
