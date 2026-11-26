/**
 * Markdown → ContextPackage adapter.
 *
 * Splits a markdown file into per-section text blocks with line-range
 * provenance. Output conforms to ContextPackage v3.1 (ADR-0002 §6).
 *
 * Why this lives in document-ingestion rather than a consumer engine:
 * doc-ingestion owns the ContextPackage format. Keeping every writer
 * next to the type definition prevents schema drift when the shape
 * evolves. ba-onboard and test-onboard both import this function.
 *
 * Section grammar:
 *   - A "section" starts at an ATX heading line (^#{1,6}\s+) and ends
 *     immediately before the next heading line (or EOF).
 *   - Content before the first heading is its own section (lead block).
 *   - Heading-only sections (no body) are emitted with the heading as
 *     the block text and an empty body — the extractor downstream still
 *     needs the heading as context, even if the body is missing.
 *   - YAML frontmatter (between `---` fences at file start) is stripped
 *     from blocks but its line range is preserved as provenance on the
 *     synthetic header block at index 0.
 */

import fs from 'fs-extra'
import path from 'node:path'
import type { BlockProvenance, ContentBlock, ContextPackage, TextBlock } from './types.js'

interface Section {
  heading: string | null
  body: string
  startLine: number
  endLine: number
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const FRONTMATTER_FENCE = '---'

/**
 * Split markdown source into sections by ATX heading.
 *
 * Exported for unit tests; production callers use `handleMarkdown` /
 * `ingestMarkdown`.
 */
export function splitMarkdownSections(source: string): {
  sections: Section[]
  frontmatterRange: [number, number] | null
} {
  const lines = source.split('\n')
  let frontmatterRange: [number, number] | null = null
  let cursor = 0

  // Strip YAML frontmatter only at file start (line 1 must be `---`).
  if (lines.length > 0 && lines[0].trim() === FRONTMATTER_FENCE) {
    let close = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === FRONTMATTER_FENCE) {
        close = i
        break
      }
    }
    if (close > 0) {
      frontmatterRange = [1, close + 1]
      cursor = close + 1
    }
  }

  const sections: Section[] = []
  let current: Section | null = null

  for (let i = cursor; i < lines.length; i++) {
    const lineNum = i + 1
    const line = lines[i]
    const m = HEADING_RE.exec(line)

    if (m) {
      if (current) {
        current.endLine = lineNum - 1
        sections.push(current)
      }
      current = {
        heading: m[2].trim(),
        body: '',
        startLine: lineNum,
        endLine: lineNum,
      }
      continue
    }

    if (!current) {
      // Pre-heading lead content — open a synthetic lead section.
      current = {
        heading: null,
        body: '',
        startLine: lineNum,
        endLine: lineNum,
      }
    }
    current.body = current.body ? `${current.body}\n${line}` : line
    current.endLine = lineNum
  }

  if (current) sections.push(current)

  // Drop lead section if it contains only whitespace — common case after
  // frontmatter strip where the first real content is a heading.
  return {
    sections: sections.filter((s, idx) => {
      if (idx === 0 && s.heading === null && s.body.trim() === '') return false
      return true
    }),
    frontmatterRange,
  }
}

/**
 * Estimate token count for a string. Mirrors the heuristic in
 * `engine/document-ingestion/src/budget.ts` — chars/4 — without
 * importing the module to keep this file self-contained.
 */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Build the synthetic header block. Mirrors the header style used by
 * `handleText` / `handlePdf` so consumers reading content_blocks see a
 * consistent "## Source: <file>" preamble per ingested document.
 */
function buildHeaderBlock(filePath: string): TextBlock {
  return {
    type: 'text',
    text: `## Source: ${path.basename(filePath)}\n- File: ${path.resolve(filePath)}`,
  }
}

function buildSectionBlock(s: Section): TextBlock {
  const lines: string[] = []
  if (s.heading) lines.push(`## ${s.heading}`)
  if (s.body.trim()) {
    if (s.heading) lines.push('')
    lines.push(s.body.replace(/\s+$/g, ''))
  }
  return { type: 'text', text: lines.join('\n') }
}

/**
 * Convert markdown source bytes into the per-block content + provenance
 * pair. Synchronous; intended for callers that already have the source
 * string in hand (tests, embedded use).
 */
export function markdownToBlocks(
  filePath: string,
  source: string,
): { blocks: ContentBlock[]; provenance: BlockProvenance[] } {
  const { sections, frontmatterRange } = splitMarkdownSections(source)

  const blocks: ContentBlock[] = []
  const provenance: BlockProvenance[] = []

  blocks.push(buildHeaderBlock(filePath))
  provenance.push(frontmatterRange ? { lines: frontmatterRange } : {})

  for (const s of sections) {
    blocks.push(buildSectionBlock(s))
    const prov: BlockProvenance = { lines: [s.startLine, s.endLine] }
    if (s.heading) prov.heading = s.heading
    provenance.push(prov)
  }

  return { blocks, provenance }
}

/**
 * Per-track handler — packager dispatches to this for `.md` files.
 * Mirrors `handleText` / `handlePdf` signatures (returns ContentBlock[]),
 * but also surfaces the parallel provenance array via the return object
 * so the packager can write v3.1 ContextPackage shape.
 */
export function handleMarkdown(filePath: string): {
  blocks: ContentBlock[]
  provenance: BlockProvenance[]
} {
  const source = fs.readFileSync(filePath, 'utf-8')
  return markdownToBlocks(filePath, source)
}

/**
 * Pattern B convenience: synthesize a full ContextPackage for a single
 * markdown file. ba-onboard and test-onboard call this directly when
 * they need to read state-A/B markdown without invoking the workflow.
 *
 * No image directory exists for markdown-only ingestion — the field is
 * populated with an absolute path that does NOT need to exist; callers
 * never read it for markdown.
 */
export async function ingestMarkdown(filePath: string): Promise<ContextPackage> {
  const resolved = path.resolve(filePath)
  const { blocks, provenance } = handleMarkdown(resolved)
  const estimated_tokens = blocks.reduce(
    (sum, b) => (b.type === 'text' ? sum + estimateTextTokens(b.text) : sum),
    0,
  )
  return {
    version: '3.1',
    generated: new Date().toISOString(),
    source_file: resolved,
    image_directory: '',
    content_blocks: blocks,
    block_provenance: provenance,
    stats: {
      total_blocks: blocks.length,
      estimated_tokens,
      image_count: 0,
    },
  }
}
