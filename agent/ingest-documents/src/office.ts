import { execFileSync, execSync } from 'node:child_process'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'

/**
 * OS-aware install command hint surfaced when LibreOffice is missing.
 * Mirrors what a user could paste into their shell on a fresh machine.
 */
function installHint(): string {
  switch (os.platform()) {
    case 'darwin':
      return 'brew install --cask libreoffice'
    case 'linux':
      return 'sudo apt install libreoffice  # or: sudo dnf install libreoffice / sudo pacman -S libreoffice-fresh'
    case 'win32':
      return 'winget install TheDocumentFoundation.LibreOffice'
    default:
      return 'see https://www.libreoffice.org/download/download/'
  }
}

export class LibreOfficeMissingError extends Error {
  constructor() {
    super(
      'LibreOffice required for .docx/.pptx ingest but `soffice` was not found on PATH.\n' +
      `Install LibreOffice: ${installHint()}`,
    )
    this.name = 'LibreOfficeMissingError'
  }
}

export function detectSoffice(): string {
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
  ]
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  try {
    const out = execSync('which soffice', { encoding: 'utf-8' }).trim()
    if (out) return out
  } catch {
    /* fall through to throw */
  }
  throw new LibreOfficeMissingError()
}

/**
 * Convert a DOCX/PPTX file to PDF via LibreOffice headless. Returns the
 * absolute path of the generated PDF in `outDir`.
 */
export function convertToPdf(filePath: string, outDir: string): string {
  const soffice = detectSoffice()
  fs.mkdirpSync(outDir)
  execFileSync(
    soffice,
    ['--headless', '--convert-to', 'pdf', '--outdir', outDir, filePath],
    { stdio: 'pipe' },
  )
  const stem = path.basename(filePath, path.extname(filePath))
  const pdfPath = path.join(outDir, `${stem}.pdf`)
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`LibreOffice did not produce expected PDF at ${pdfPath}`)
  }
  return pdfPath
}
