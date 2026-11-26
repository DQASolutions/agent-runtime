import fs from 'fs-extra'
import path from 'node:path'
import { TRANSPORT_TRACKS, needsConversion } from './transport-classifier.js'
import type { ClassifiedFile, InputsFile, Track } from './types.js'

/**
 * Extension → transport track. Re-exported from `./transport-classifier.ts`, the single
 * source of truth for the extension→format taxonomy (ADR-0002 Amendment 2).
 * Kept under the historical name `TRACKS` for document-ingestion's existing
 * public surface (`index.ts` re-exports it).
 */
export const TRACKS: Readonly<Record<string, Track>> = TRANSPORT_TRACKS

export const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function kebabize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

/** Options for {@link scanFolder}. */
export interface ScanOptions {
  /**
   * Keep only files whose track needs conversion (office / xlsx). Used by
   * the embedded onboarding `ingest` phase, which reads native text / PDF /
   * images directly and routes only binaries through document-ingestion
   * (ADR-0002 Amendment 2). Default false — scan keeps every known track.
   */
  needsConversionOnly?: boolean
}

/**
 * Walk `folder` recursively and assign a track to every file whose extension
 * is known. Files with unknown extensions are recorded under `skipped`.
 *
 * With `needsConversionOnly`, the returned `files` are narrowed to the
 * office / xlsx tracks; `skipped` still lists genuinely-unsupported files.
 */
export async function scanFolder(
  folder: string,
  opts: ScanOptions = {},
): Promise<InputsFile> {
  const files: ClassifiedFile[] = []
  const skipped: InputsFile['skipped'] = []
  const usedNames = new Set<string>()

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      const track = TRACKS[ext] ?? null
      if (!track) {
        skipped.push({ path: full, extension: ext, reason: 'unsupported extension' })
        continue
      }
      const stem = path.basename(entry.name, path.extname(entry.name))
      let kebab = kebabize(stem) || 'file'
      let suffix = 1
      while (usedNames.has(kebab)) {
        suffix += 1
        kebab = `${kebabize(stem)}-${suffix}`
      }
      usedNames.add(kebab)
      files.push({ path: full, track, kebabName: kebab, extension: ext })
    }
  }

  await walk(folder)

  const selected = opts.needsConversionOnly
    ? files.filter((f) => f.track !== null && needsConversion(f.track))
    : files
  return { sourceFolder: folder, files: selected, skipped }
}
