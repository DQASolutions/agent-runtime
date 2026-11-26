// Read an app declaration file by base name, trying `.yaml` → `.yml` → `.json`.
// Parsed with js-yaml: YAML is a superset of JSON, so a `.json` app still loads
// unchanged — this lets apps move to YAML (comments, readability) without a
// breaking change. The workflow engine itself is format-agnostic (it receives a
// parsed object), so the choice of YAML/JSON lives entirely in this loader.

import fs from 'fs-extra'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Load `<appDir>/<base>.(yaml|yml|json)` (first match wins) and parse it.
 * Pass `fallback` for an optional file (returned when none of the extensions
 * exist); omit it to require the file (throws when missing).
 */
export async function readAppDecl<T>(appDir: string, base: string, fallback?: T): Promise<T> {
  for (const ext of ['yaml', 'yml', 'json']) {
    const p = path.join(appDir, `${base}.${ext}`)
    if (await fs.pathExists(p)) {
      return yaml.load(await fs.readFile(p, 'utf-8')) as T
    }
  }
  if (fallback !== undefined) return fallback
  throw new Error(`app file not found: ${base}.(yaml|yml|json) in ${appDir}`)
}
