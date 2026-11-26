import fs from 'fs-extra'
import path from 'node:path'
import { glob } from 'glob'

/**
 * Snapshot of a sibling workflow run's state, exposed under `ctx.runs[runId]`
 * for cross-workflow gate dependency expressions in composite orchestration.
 *
 * Populated by Orchestrator.makeExprContext() when the active workflow has any
 * gate carrying `depends-on-run`. Empty object when no cross-run references
 * exist — keeps the cost of loading sibling state out of the hot path for
 * single-workflow runs.
 */
export interface RunSnapshot {
  /** Gate id → event. status === 'passed' indicates the gate has been approved. */
  gates: Record<string, { status: string; at: string; by?: string }>
  /** Sibling run's accumulated exports (Record same shape as ExpressionContext.exports). */
  exports: Record<string, unknown>
}

export interface ExpressionContext {
  exports: Record<string, unknown>
  baseDir: string
  /**
   * Sibling run snapshots keyed by run id (e.g. `acme--ba`). Optional —
   * absent when the active workflow doesn't reference any sibling run.
   */
  runs?: Record<string, RunSnapshot>
}

/**
 * Evaluate a simple expression against a context.
 *
 * Supports:
 *   - Variable references: `x`, `scoping.route`
 *   - Comparison: `==`, `!=`, `>`, `<`, `>=`, `<=`
 *   - Logical: `and`, `or`, `not`
 *   - Includes: `route includes C1`
 *   - Functions: `file-exists(path)`, `glob-count(pattern)`
 *
 * Returns boolean for comparisons/logical, raw value for single references.
 */
export async function evaluateExpression(
  expr: string,
  context: ExpressionContext,
): Promise<unknown> {
  const tokens = tokenize(expr)
  const result = await evalTokens(tokens, context)
  return result
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

type Token =
  | { type: 'identifier'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'function'; name: string; arg: string }
  | { type: 'keyword'; value: string }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const s = expr.trim()

  while (i < s.length) {
    // Skip whitespace
    if (s[i] === ' ' || s[i] === '\t') { i++; continue }

    // Quoted string — accept both " and ' (workflow authors use either).
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i]
      let val = ''
      i++ // skip opening quote
      while (i < s.length && s[i] !== quote) {
        val += s[i]; i++
      }
      i++ // skip closing quote
      tokens.push({ type: 'string', value: val })
      continue
    }

    // Operators (multi-char first)
    if (s.slice(i, i + 2) === '>=') { tokens.push({ type: 'operator', value: '>=' }); i += 2; continue }
    if (s.slice(i, i + 2) === '<=') { tokens.push({ type: 'operator', value: '<=' }); i += 2; continue }
    if (s.slice(i, i + 2) === '!=') { tokens.push({ type: 'operator', value: '!=' }); i += 2; continue }
    if (s.slice(i, i + 2) === '==') { tokens.push({ type: 'operator', value: '==' }); i += 2; continue }
    if (s[i] === '>' && s[i + 1] !== '=') { tokens.push({ type: 'operator', value: '>' }); i++; continue }
    if (s[i] === '<' && s[i + 1] !== '=') { tokens.push({ type: 'operator', value: '<' }); i++; continue }

    // Function call: name(arg)
    const fnMatch = s.slice(i).match(/^([a-z][\w-]*)\(([^)]*)\)/)
    if (fnMatch) {
      tokens.push({ type: 'function', name: fnMatch[1], arg: fnMatch[2] })
      i += fnMatch[0].length
      continue
    }

    // Standalone parentheses (for not (...) grouping) + list brackets/commas
    // (for `x in [a, b]` membership). Tracked as punctuation tokens; depth
    // helpers count both ( ) and [ ].
    if (s[i] === '(' || s[i] === ')' || s[i] === '[' || s[i] === ']' || s[i] === ',') {
      tokens.push({ type: 'identifier', value: s[i] })
      i++
      continue
    }

    // Word: identifier, keyword, boolean, or number
    const wordMatch = s.slice(i).match(/^[^\s=!<>()[\],]+/)
    if (wordMatch) {
      const word = wordMatch[0]
      i += word.length

      // Reserved keywords + booleans are case-insensitive (`AND`/`and`/`And`
      // all parse the same). Identifiers stay case-sensitive — paths like
      // `runs.acme--BA` must preserve case.
      const lower = word.toLowerCase()
      if (lower === 'true') { tokens.push({ type: 'boolean', value: true }); continue }
      if (lower === 'false') { tokens.push({ type: 'boolean', value: false }); continue }
      if (lower === 'and' || lower === 'or' || lower === 'not' || lower === 'includes' || lower === 'in') {
        tokens.push({ type: 'keyword', value: lower }); continue
      }
      if (/^\d+(\.\d+)?$/.test(word)) {
        tokens.push({ type: 'number', value: Number(word) }); continue
      }

      tokens.push({ type: 'identifier', value: word })
      continue
    }

    i++
  }

  return tokens
}

// ── Evaluator ──────────────────────────────────────────────────────────────

async function evalTokens(tokens: Token[], ctx: ExpressionContext): Promise<unknown> {
  // Handle 'not' prefix — with optional parenthesized sub-expression
  if (tokens.length >= 2 && tokens[0].type === 'keyword' && tokens[0].value === 'not') {
    let innerTokens = tokens.slice(1)
    // Strip wrapping parentheses: not (...) → not ...
    if (isWrappedInParens(innerTokens)) {
      innerTokens = innerTokens.slice(1, -1)
    }
    const inner = await evalTokens(innerTokens, ctx)
    return !inner
  }

  // Strip wrapping parentheses: (...) → ...
  if (isWrappedInParens(tokens)) {
    return evalTokens(tokens.slice(1, -1), ctx)
  }

  // List literal: [a, b, c] → array of resolved element values
  if (isWrappedInBrackets(tokens)) {
    return evalListElements(tokens.slice(1, -1), ctx)
  }

  // Find lowest-precedence logical operator (and/or) — right-to-left scan
  for (const op of ['or', 'and']) {
    const idx = findKeyword(tokens, op)
    if (idx !== -1) {
      const left = await evalTokens(tokens.slice(0, idx), ctx)
      const right = await evalTokens(tokens.slice(idx + 1), ctx)
      if (op === 'and') return Boolean(left) && Boolean(right)
      if (op === 'or') return Boolean(left) || Boolean(right)
    }
  }

  // Find 'includes' operator
  const inclIdx = findKeyword(tokens, 'includes')
  if (inclIdx !== -1) {
    const left = await evalTokens(tokens.slice(0, inclIdx), ctx)
    const right = await evalTokens(tokens.slice(inclIdx + 1), ctx)
    if (Array.isArray(left)) return left.includes(right)
    if (typeof left === 'string') return left.includes(String(right))
    return false
  }

  // Find 'in' operator — membership: LEFT in [a, b, ...] (or an array value)
  const inIdx = findKeyword(tokens, 'in')
  if (inIdx !== -1) {
    const left = await evalTokens(tokens.slice(0, inIdx), ctx)
    const right = await evalTokens(tokens.slice(inIdx + 1), ctx)
    if (Array.isArray(right)) {
      const l = coerce(left)
      return right.some(v => coerce(v) === l)
    }
    return false
  }

  // Find comparison operator
  const cmpIdx = findOperatorAtTopLevel(tokens)
  if (cmpIdx !== -1) {
    const op = (tokens[cmpIdx] as { type: 'operator'; value: string }).value
    const left = await evalTokens(tokens.slice(0, cmpIdx), ctx)
    const right = await evalTokens(tokens.slice(cmpIdx + 1), ctx)
    return compare(left, right, op)
  }

  // Single token
  if (tokens.length === 1) {
    return resolveToken(tokens[0], ctx)
  }

  // Should not reach here with valid expressions
  throw new Error(`Cannot evaluate expression tokens: ${tokens.map(t => JSON.stringify(t)).join(' ')}`)
}

/** Find a keyword at the top level (not inside parentheses) */
function findKeyword(tokens: Token[], keyword: string): number {
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'identifier' && ((tokens[i] as { value: string }).value === '(' || (tokens[i] as { value: string }).value === '[')) depth++
    if (tokens[i].type === 'identifier' && ((tokens[i] as { value: string }).value === ')' || (tokens[i] as { value: string }).value === ']')) depth--
    if (depth === 0 && tokens[i].type === 'keyword' && (tokens[i] as { value: string }).value === keyword) {
      return i
    }
  }
  return -1
}

/** Find a comparison operator at the top level (not inside parentheses) */
function findOperatorAtTopLevel(tokens: Token[]): number {
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'identifier' && ((tokens[i] as { value: string }).value === '(' || (tokens[i] as { value: string }).value === '[')) depth++
    if (tokens[i].type === 'identifier' && ((tokens[i] as { value: string }).value === ')' || (tokens[i] as { value: string }).value === ']')) depth--
    if (depth === 0 && tokens[i].type === 'operator') return i
  }
  return -1
}

/** Check if tokens are wrapped in a matched pair of parentheses */
function isWrappedInParens(tokens: Token[]): boolean {
  if (tokens.length < 3) return false
  const first = tokens[0]
  const last = tokens[tokens.length - 1]
  if (first.type !== 'identifier' || (first as { value: string }).value !== '(') return false
  if (last.type !== 'identifier' || (last as { value: string }).value !== ')') return false
  // Verify the opening paren matches the closing one (depth never hits 0 before the end)
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'identifier' && ((tokens[i] as { value: string }).value === '(' || (tokens[i] as { value: string }).value === '[')) depth++
    if (tokens[i].type === 'identifier' && ((tokens[i] as { value: string }).value === ')' || (tokens[i] as { value: string }).value === ']')) depth--
    if (depth === 0 && i < tokens.length - 1) return false
  }
  return depth === 0
}

/** Check if tokens are wrapped in a matched pair of list brackets `[ ... ]`. */
function isWrappedInBrackets(tokens: Token[]): boolean {
  if (tokens.length < 2) return false
  const first = tokens[0]
  const last = tokens[tokens.length - 1]
  if (first.type !== 'identifier' || (first as { value: string }).value !== '[') return false
  if (last.type !== 'identifier' || (last as { value: string }).value !== ']') return false
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].type === 'identifier' ? (tokens[i] as { value: string }).value : ''
    if (v === '[' || v === '(') depth++
    if (v === ']' || v === ')') depth--
    if (depth === 0 && i < tokens.length - 1) return false
  }
  return depth === 0
}

/** Evaluate the elements of a list literal (top-level comma split → array). */
async function evalListElements(tokens: Token[], ctx: ExpressionContext): Promise<unknown[]> {
  if (tokens.length === 0) return []
  const out: unknown[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].type === 'identifier' ? (tokens[i] as { value: string }).value : ''
    if (v === '[' || v === '(') depth++
    else if (v === ']' || v === ')') depth--
    else if (depth === 0 && v === ',') {
      out.push(await evalTokens(tokens.slice(start, i), ctx))
      start = i + 1
    }
  }
  out.push(await evalTokens(tokens.slice(start), ctx))
  return out
}

async function resolveToken(token: Token, ctx: ExpressionContext): Promise<unknown> {
  switch (token.type) {
    case 'boolean': return token.value
    case 'number': return token.value
    case 'string': return token.value
    case 'identifier': return resolveIdentifier(token.value, ctx)
    case 'function': return resolveFunction(token.name, token.arg, ctx)
    default:
      throw new Error(`Unexpected token type: ${token.type}`)
  }
}

/**
 * Report whether an identifier resolves to a defined value in the context.
 * Mirrors `resolveIdentifier`'s traversal, but distinguishes "not found" from
 * "found a value that happens to equal the identifier name" — `resolveIdentifier`
 * returns the name itself as a sentinel for unresolvable, which callers cannot
 * tell apart from a real value. Used to produce actionable validate-failure
 * diagnostics ("metric X was never declared") instead of echoing the raw rule.
 */
export function isDefinedIdentifier(name: string, ctx: ExpressionContext): boolean {
  if (name.startsWith('runs.') && ctx.runs) {
    const parts = name.slice('runs.'.length).split('.')
    let current: unknown = ctx.runs
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return false
      current = (current as Record<string, unknown>)[part]
    }
    return current !== undefined
  }
  if (name in ctx.exports) return ctx.exports[name] !== undefined
  const parts = name.split('.')
  let current: unknown = ctx.exports
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return false
    current = (current as Record<string, unknown>)[part]
  }
  return current !== undefined
}

function resolveIdentifier(name: string, ctx: ExpressionContext): unknown {
  // ── Cross-run namespace: `runs.<run-id>.gates.<gate-id>[.field]` ────────
  // Resolves against the sibling-run snapshots populated by Orchestrator
  // when the active workflow has cross-run gate dependencies.
  if (name.startsWith('runs.') && ctx.runs) {
    const parts = name.slice('runs.'.length).split('.')
    let current: unknown = ctx.runs
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return name
      current = (current as Record<string, unknown>)[part]
    }
    return current ?? name
  }

  // Direct key lookup (supports dotted paths stored as flat keys)
  if (name in ctx.exports) return ctx.exports[name]

  // Try nested object traversal
  const parts = name.split('.')
  let current: unknown = ctx.exports
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      // Unresolvable — return the string itself (for comparison as literal)
      return name
    }
    current = (current as Record<string, unknown>)[part]
  }
  if (current !== undefined) return current

  // Return the string itself as a literal value (e.g., "PASS", "C1")
  return name
}

/** Split a function arg list on top-level commas. Trims surrounding quotes. */
function splitArgs(arg: string): string[] {
  return arg
    .split(',')
    .map(s => s.trim())
    .map(s => (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
      ? s.slice(1, -1)
      : s)
}

async function resolveFunction(name: string, arg: string, ctx: ExpressionContext): Promise<unknown> {
  switch (name) {
    case 'defined': {
      // True when the identifier resolves to a present value in the context.
      return isDefinedIdentifier(arg.trim(), ctx)
    }
    case 'empty': {
      // True when the identifier is undefined/null/""/[].
      if (!isDefinedIdentifier(arg.trim(), ctx)) return true
      const v = resolveIdentifier(arg.trim(), ctx)
      return v == null || v === '' || (Array.isArray(v) && v.length === 0)
    }
    case 'file-exists': {
      const fullPath = path.resolve(ctx.baseDir, arg)
      return fs.pathExists(fullPath)
    }
    case 'glob-count': {
      const matches = await glob(arg, { cwd: ctx.baseDir, nodir: true })
      return matches.length
    }
    case 'file-content': {
      const fullPath = path.resolve(ctx.baseDir, arg)
      if (!(await fs.pathExists(fullPath))) {
        throw new Error(`file-content: file not found: ${fullPath}`)
      }
      return fs.readFile(fullPath, 'utf-8')
    }
    // ── Cross-run helpers (Composite orchestration) ───────────────────────
    case 'gate-approved': {
      // Usage: gate-approved("<run-id>", "<gate-id>")
      // Returns true iff the named sibling run has approved the named gate.
      const [runId, gateId] = splitArgs(arg)
      if (!ctx.runs || !runId || !gateId) return false
      const run = ctx.runs[runId]
      return run?.gates?.[gateId]?.status === 'passed'
    }
    case 'run-complete': {
      // Usage: run-complete("<run-id>")
      // Returns true iff the named sibling run is fully complete (no pending
      // tasks). Implementation note: completeness is decided at the call
      // site by checking whether a `_complete` marker exists in the
      // run-snapshot's gates record. Orchestrator writes that marker on
      // workflow completion.
      const [runId] = splitArgs(arg)
      if (!ctx.runs || !runId) return false
      const run = ctx.runs[runId]
      return run?.gates?._complete?.status === 'passed'
    }
    case 'bundle-ready': {
      // Usage: bundle-ready("<run-id>", "<bundle-id>")
      // Returns true iff the named sibling run has produced the named
      // ArtifactBundle. Current heuristic: the run's hand-off gate
      // (declared with `bundles-required: [<bundle-id>]`) has been approved.
      // Phase 2.5+ may enrich this with a full `dqa handoff verify` check
      // — for now, gate-approved on the producing workflow is sufficient
      // since the bundles-required field is verified at gate time.
      const [runId, bundleId] = splitArgs(arg)
      if (!ctx.runs || !runId || !bundleId) return false
      const run = ctx.runs[runId]
      if (!run) return false
      // Look for any gate event whose recorded bundles-required contains
      // bundleId. Without that index here, fall back to checking for any
      // `_bundle:<bundleId>` marker (written by orchestrator at gate
      // approval time when the gate carries bundles-required).
      return run.gates[`_bundle:${bundleId}`]?.status === 'passed'
    }
    default:
      throw new Error(`Unknown function: ${name}`)
  }
}

function compare(left: unknown, right: unknown, op: string): boolean {
  // Coerce types for comparison
  const l = coerce(left)
  const r = coerce(right)

  switch (op) {
    case '==': return l === r
    case '!=': return l !== r
    case '>': return Number(l) > Number(r)
    case '<': return Number(l) < Number(r)
    case '>=': return Number(l) >= Number(r)
    case '<=': return Number(l) <= Number(r)
    default:
      throw new Error(`Unknown operator: ${op}`)
  }
}

function coerce(value: unknown): string | number | boolean {
  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
    const n = Number(value)
    if (!isNaN(n) && value.trim() !== '') return n
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}
