import type { ContentBlock, Manifest } from './types.js'

export function estimateTokens(blocks: ContentBlock[]): number {
  let total = 0
  for (const b of blocks) {
    if (b.type === 'document') total += 16000
    else if (b.type === 'image') total += 1600
    else if (b.type === 'text') total += Math.ceil((b.text?.length ?? 0) / 4)
  }
  return total
}

export interface BudgetOptions {
  maxTokens: number
  maxImages: number
}

/**
 * Anthropic Messages API hard cap per request — non-negotiable, comes from
 * the API contract. We always raise a warning when the consolidated image
 * count exceeds this, regardless of any user-supplied budget. User flags
 * can only narrow the budget (tighten alerting at a lower count); they
 * cannot loosen it past the Anthropic ceiling.
 */
export const ANTHROPIC_IMAGE_HARD_LIMIT = 100

/**
 * Default soft budget for tokens — well under Anthropic's 200k context
 * window so the ingested artifact still has headroom for the rule prompt
 * and response. User-tunable via --max-tokens.
 */
export const DEFAULT_INGEST_MAX_TOKENS = 180_000

/**
 * Default soft budget for images — pinned to the Anthropic hard limit so
 * the default behaviour matches the API constraint exactly. User can lower
 * via --max-images for earlier alerting; raising it does NOT silence the
 * Anthropic hard-limit warning.
 */
export const DEFAULT_INGEST_MAX_IMAGES = ANTHROPIC_IMAGE_HARD_LIMIT

export type BudgetWarningKind =
  | 'tokens'
  | 'images-anthropic-limit'   // hard, never silenceable
  | 'images-user-budget'        // soft, fires only when user budget < hard limit

export interface BudgetWarning {
  kind: BudgetWarningKind
  total: number
  limit: number
  message: string
}

/**
 * Compute warnings (if any) for an in-progress ingest based on cumulative
 * counters. Pure function — emit/print is the caller's responsibility so
 * tests can assert on the structured result.
 *
 * Image gate has two independent layers:
 *   1. Anthropic 100-image hard limit — fires unconditionally when crossed.
 *      Comes from the API contract. Cannot be silenced by user flags.
 *   2. User-supplied soft budget (`limits.maxImages`) — fires only when
 *      it is *stricter* than the hard limit (i.e. < 100). Lets users opt
 *      into earlier alerting without giving them a way to bypass the API
 *      contract.
 */
export function evaluateIngestBudget(
  totals: { tokens: number; images: number },
  limits: BudgetOptions = { maxTokens: DEFAULT_INGEST_MAX_TOKENS, maxImages: DEFAULT_INGEST_MAX_IMAGES },
): BudgetWarning[] {
  const warnings: BudgetWarning[] = []

  if (totals.tokens > limits.maxTokens) {
    warnings.push({
      kind: 'tokens',
      total: totals.tokens,
      limit: limits.maxTokens,
      message:
        `estimated tokens ${totals.tokens.toLocaleString()} exceed budget ${limits.maxTokens.toLocaleString()} ` +
        `— the consolidated context will not fit Anthropic's context window in a single call. ` +
        `Split the source folder or run with --max-tokens <N> to silence this warning.`,
    })
  }

  // Layer 1: Anthropic hard limit (always evaluated, never silenced).
  if (totals.images > ANTHROPIC_IMAGE_HARD_LIMIT) {
    warnings.push({
      kind: 'images-anthropic-limit',
      total: totals.images,
      limit: ANTHROPIC_IMAGE_HARD_LIMIT,
      message:
        `image count ${totals.images} exceeds Anthropic Messages API hard limit of ` +
        `${ANTHROPIC_IMAGE_HARD_LIMIT} blocks per request — the consolidated context cannot be ` +
        `sent as one API call. Reduce images or batch the ingest. ` +
        `(This warning is not silenceable: it reflects the API contract, not a budget.)`,
    })
  }

  // Layer 2: user soft budget — only meaningful when stricter than the hard limit.
  if (
    limits.maxImages < ANTHROPIC_IMAGE_HARD_LIMIT &&
    totals.images > limits.maxImages &&
    totals.images <= ANTHROPIC_IMAGE_HARD_LIMIT
  ) {
    warnings.push({
      kind: 'images-user-budget',
      total: totals.images,
      limit: limits.maxImages,
      message:
        `image count ${totals.images} exceeds the configured budget of ${limits.maxImages} ` +
        `(Anthropic API still accepts up to ${ANTHROPIC_IMAGE_HARD_LIMIT}). ` +
        `Raise --max-images or remove the flag to silence this warning.`,
    })
  }

  return warnings
}

export function buildBudgetReport(manifest: Manifest, opts: BudgetOptions): string {
  const lines: string[] = []
  lines.push('# Ingest Budget Report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Limits: maxTokens=${opts.maxTokens}, maxImages=${opts.maxImages}`)
  lines.push('')
  lines.push('| Source | Tokens | Images | Status |')
  lines.push('|---|---:|---:|---|')

  let violations = 0
  for (const f of manifest.files) {
    const overTok = f.stats.estimated_tokens > opts.maxTokens
    const overImg = f.stats.image_count > opts.maxImages
    const status = overTok || overImg ? 'CRITICAL' : 'OK'
    if (overTok || overImg) violations++
    lines.push(
      `| ${f.source} | ${f.stats.estimated_tokens} | ${f.stats.image_count} | ${status}${
        overTok ? ' (tokens)' : ''
      }${overImg ? ' (images)' : ''} |`,
    )
  }
  lines.push('')
  lines.push(`Total files: ${manifest.files.length}`)
  lines.push(`Violations: ${violations}`)
  return lines.join('\n') + '\n'
}
