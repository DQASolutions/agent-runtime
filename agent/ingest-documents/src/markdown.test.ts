import { describe, expect, it } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import {
  handleMarkdown,
  ingestMarkdown,
  markdownToBlocks,
  splitMarkdownSections,
} from './markdown.js'

function tmpFile(content: string, name = 'sample.md'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dqa-md-test-'))
  const fp = path.join(dir, name)
  fs.writeFileSync(fp, content)
  return fp
}

describe('splitMarkdownSections', () => {
  it('splits by H1/H2/H3 ATX headings', () => {
    const { sections, frontmatterRange } = splitMarkdownSections(
      [
        '# Title',
        'lead under title',
        '',
        '## Sub one',
        'body one',
        '',
        '### Deep three',
        'body three',
        '',
        '## Sub two',
        'body two',
      ].join('\n'),
    )
    expect(frontmatterRange).toBeNull()
    expect(sections.map(s => s.heading)).toEqual([
      'Title',
      'Sub one',
      'Deep three',
      'Sub two',
    ])
    expect(sections[0].startLine).toBe(1)
    expect(sections[1].startLine).toBe(4)
  })

  it('extracts and strips YAML frontmatter', () => {
    const { sections, frontmatterRange } = splitMarkdownSections(
      ['---', 'id: STORY-001', 'title: Login', '---', '## User Story', 'As a user…'].join('\n'),
    )
    expect(frontmatterRange).toEqual([1, 4])
    expect(sections).toHaveLength(1)
    expect(sections[0].heading).toBe('User Story')
    expect(sections[0].startLine).toBe(5)
  })

  it('keeps pre-heading lead content as a section with heading=null', () => {
    const { sections } = splitMarkdownSections(
      ['intro paragraph', 'second line', '', '## First Heading', 'body'].join('\n'),
    )
    expect(sections[0].heading).toBeNull()
    expect(sections[0].body).toContain('intro paragraph')
    expect(sections[1].heading).toBe('First Heading')
  })

  it('drops a lead section that is only whitespace', () => {
    const { sections } = splitMarkdownSections(['', '', '## Heading', 'body'].join('\n'))
    expect(sections).toHaveLength(1)
    expect(sections[0].heading).toBe('Heading')
  })

  it('preserves heading-only sections (no body)', () => {
    const { sections } = splitMarkdownSections(['## Empty', '', '## Next', 'has body'].join('\n'))
    expect(sections).toHaveLength(2)
    expect(sections[0].heading).toBe('Empty')
    expect(sections[0].body.trim()).toBe('')
  })

  it('records line ranges spanning multi-line bodies', () => {
    const { sections } = splitMarkdownSections(
      ['## Story', 'line a', 'line b', 'line c', '', '## Next', 'x'].join('\n'),
    )
    expect(sections[0].startLine).toBe(1)
    expect(sections[0].endLine).toBeGreaterThanOrEqual(4)
    expect(sections[1].startLine).toBe(6)
  })
})

describe('markdownToBlocks', () => {
  it('emits a synthetic header block followed by per-section blocks', () => {
    const { blocks, provenance } = markdownToBlocks(
      '/tmp/story.md',
      ['## User Story', 'As a user…', '', '## AC', '- crit 1'].join('\n'),
    )
    expect(blocks).toHaveLength(3)
    expect(blocks[0].type).toBe('text')
    expect((blocks[0] as { text: string }).text).toContain('## Source: story.md')
    expect((blocks[1] as { text: string }).text).toContain('## User Story')
    expect((blocks[2] as { text: string }).text).toContain('## AC')
    expect(provenance).toHaveLength(3)
    expect(provenance[0]).toEqual({}) // synthetic header — no specific locator
    expect(provenance[1].heading).toBe('User Story')
    expect(provenance[2].heading).toBe('AC')
    expect(provenance[1].lines).toBeDefined()
  })

  it('records frontmatter line range on the synthetic header block', () => {
    const { provenance } = markdownToBlocks(
      '/tmp/x.md',
      ['---', 'id: S001', '---', '## Story', 'body'].join('\n'),
    )
    expect(provenance[0].lines).toEqual([1, 3])
  })
})

describe('handleMarkdown (file read)', () => {
  it('reads file from disk and produces blocks + provenance', () => {
    const fp = tmpFile('## Title\nbody line')
    const { blocks, provenance } = handleMarkdown(fp)
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(provenance.length).toBe(blocks.length)
  })
})

describe('ingestMarkdown (full ContextPackage)', () => {
  it('returns v3.1 ContextPackage with block_provenance', async () => {
    const fp = tmpFile('## One\nfirst\n\n## Two\nsecond')
    const pkg = await ingestMarkdown(fp)
    expect(pkg.version).toBe('3.1')
    expect(pkg.source_file).toBe(path.resolve(fp))
    expect(pkg.content_blocks.length).toBeGreaterThanOrEqual(3)
    expect(pkg.block_provenance).toBeDefined()
    expect(pkg.block_provenance!.length).toBe(pkg.content_blocks.length)
    expect(pkg.stats.image_count).toBe(0)
    expect(pkg.stats.estimated_tokens).toBeGreaterThan(0)
  })

  it('survives empty markdown without throwing', async () => {
    const fp = tmpFile('')
    const pkg = await ingestMarkdown(fp)
    expect(pkg.content_blocks).toHaveLength(1) // header only
    expect(pkg.block_provenance).toHaveLength(1)
  })
})
