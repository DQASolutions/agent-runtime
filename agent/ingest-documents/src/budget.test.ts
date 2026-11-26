import { describe, expect, it } from 'vitest'
import {
  buildBudgetReport,
  estimateTokens,
  evaluateIngestBudget,
  DEFAULT_INGEST_MAX_IMAGES,
  DEFAULT_INGEST_MAX_TOKENS,
} from './budget.js'
import type { ContentBlock, Manifest } from './types.js'

describe('estimateTokens', () => {
  it('charges 16000 per document block', () => {
    const blocks: ContentBlock[] = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: '' } },
    ]
    expect(estimateTokens(blocks)).toBe(16000)
  })

  it('charges 1600 per image block', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
    ]
    expect(estimateTokens(blocks)).toBe(3200)
  })

  it('estimates text at ~4 chars per token', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'a'.repeat(400) }]
    expect(estimateTokens(blocks)).toBe(100)
  })

  it('sums mixed block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a'.repeat(40) }, // 10
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }, // 1600
    ]
    expect(estimateTokens(blocks)).toBe(1610)
  })
})

describe('buildBudgetReport', () => {
  const manifest: Manifest = {
    version: '3.0',
    generated: '2026-04-13T10:00:00.000Z',
    files: [
      {
        source: 'a.xlsx',
        output_dir: 'out/a',
        context_file: 'out/a/context.json',
        image_directory: 'out/a/images',
        stats: { total_blocks: 3, estimated_tokens: 5000, image_count: 2 },
      },
      {
        source: 'b.pdf',
        output_dir: 'out/b',
        context_file: 'out/b/context.json',
        image_directory: 'out/b/images',
        stats: { total_blocks: 2, estimated_tokens: 200000, image_count: 150 },
      },
    ],
    totals: { total_tokens: 205000, total_images: 152, total_blocks: 5 },
    budget_warnings: [],
  }

  it('flags files exceeding token budget', () => {
    const report = buildBudgetReport(manifest, { maxTokens: 180000, maxImages: 100 })
    expect(report).toContain('CRITICAL (tokens) (images)')
    expect(report).toContain('a.xlsx')
    expect(report).toContain('Violations: 1')
  })

  it('reports all OK when nothing exceeds', () => {
    const report = buildBudgetReport(manifest, { maxTokens: 1_000_000, maxImages: 1000 })
    expect(report).toContain('Violations: 0')
    expect(report).not.toContain('CRITICAL')
  })
})

describe('evaluateIngestBudget (DI-05/DI-06 inline gate)', () => {
  it('returns no warnings when totals are under defaults', () => {
    const w = evaluateIngestBudget({ tokens: 100_000, images: 50 })
    expect(w).toEqual([])
  })

  it('warns when token total exceeds the default 180k threshold', () => {
    const w = evaluateIngestBudget({ tokens: 200_000, images: 10 })
    expect(w).toHaveLength(1)
    expect(w[0].kind).toBe('tokens')
    expect(w[0].limit).toBe(DEFAULT_INGEST_MAX_TOKENS)
    expect(w[0].total).toBe(200_000)
    expect(w[0].message).toMatch(/exceed budget/)
  })

  it("warns when image total exceeds Anthropic's 100-image hard limit", () => {
    const w = evaluateIngestBudget({ tokens: 1_000, images: 150 })
    const anthropic = w.find(x => x.kind === 'images-anthropic-limit')
    expect(anthropic).toBeDefined()
    expect(anthropic!.limit).toBe(100)
    expect(anthropic!.total).toBe(150)
    expect(anthropic!.message).toMatch(/Anthropic/)
    expect(anthropic!.message).toMatch(/not silenceable/i)
  })

  it('returns the token warning alongside the Anthropic image warning when both overflow', () => {
    const w = evaluateIngestBudget({ tokens: 200_000, images: 150 })
    expect(w.map(x => x.kind).sort()).toEqual(['images-anthropic-limit', 'tokens'])
  })

  it('emits a separate user-budget warning when --max-images is stricter than the Anthropic limit', () => {
    const w = evaluateIngestBudget(
      { tokens: 0, images: 30 },
      { maxTokens: 1_000_000, maxImages: 10 },
    )
    expect(w).toHaveLength(1)
    expect(w[0].kind).toBe('images-user-budget')
    expect(w[0].limit).toBe(10)
  })

  it('does NOT raise the user-budget warning once the Anthropic limit is also crossed (no duplication)', () => {
    const w = evaluateIngestBudget(
      { tokens: 0, images: 200 },
      { maxTokens: 1_000_000, maxImages: 50 },
    )
    // Both thresholds are crossed but only the harder, more informative
    // anthropic-limit warning fires — duplicating user-budget at this point
    // would be noise, since 100 ⊆ 50 from the alerting POV.
    expect(w.map(x => x.kind)).toEqual(['images-anthropic-limit'])
  })

  it('CANNOT silence the Anthropic hard limit by raising --max-images above 100', () => {
    // Regression for DI-06 hardening: user passes --max-images 5000, the
    // 100-image hard limit warning still fires because it tracks the API
    // contract, not the user budget.
    const w = evaluateIngestBudget(
      { tokens: 0, images: 200 },
      { maxTokens: 1_000_000, maxImages: 5000 },
    )
    expect(w.some(x => x.kind === 'images-anthropic-limit')).toBe(true)
  })
})
