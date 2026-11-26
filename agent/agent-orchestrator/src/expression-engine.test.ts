import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { evaluateExpression } from './expression-engine.js'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-expr-'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

const ctx = (exports: Record<string, unknown> = {}, baseDir?: string) => ({
  exports,
  baseDir: baseDir ?? tmpDir,
})

describe('evaluateExpression', () => {
  // ── Literal comparison ──────────────────────────────────────────────────

  it('evaluates "x == true" to true', async () => {
    expect(await evaluateExpression('x == true', ctx({ x: true }))).toBe(true)
  })

  it('evaluates "x == false" to false when x is true', async () => {
    expect(await evaluateExpression('x == false', ctx({ x: true }))).toBe(false)
  })

  it('evaluates "count > 5" to true', async () => {
    expect(await evaluateExpression('count > 5', ctx({ count: 10 }))).toBe(true)
  })

  it('evaluates "count > 5" to false', async () => {
    expect(await evaluateExpression('count > 5', ctx({ count: 3 }))).toBe(false)
  })

  it('evaluates "count < 5" correctly', async () => {
    expect(await evaluateExpression('count < 5', ctx({ count: 3 }))).toBe(true)
  })

  it('evaluates "count >= 10" correctly', async () => {
    expect(await evaluateExpression('count >= 10', ctx({ count: 10 }))).toBe(true)
  })

  it('evaluates "count <= 10" correctly', async () => {
    expect(await evaluateExpression('count <= 9', ctx({ count: 10 }))).toBe(false)
  })

  it('evaluates "name == PASS" as string comparison', async () => {
    expect(await evaluateExpression('name == PASS', ctx({ name: 'PASS' }))).toBe(true)
    expect(await evaluateExpression('name == PASS', ctx({ name: 'FAIL' }))).toBe(false)
  })

  it('evaluates "name != FAIL" correctly', async () => {
    expect(await evaluateExpression('name != FAIL', ctx({ name: 'PASS' }))).toBe(true)
  })

  // ── Dotted path resolution ──────────────────────────────────────────────

  it('evaluates dotted path "scoping.route" to array value', async () => {
    const result = await evaluateExpression('scoping.route', ctx({
      'scoping.route': ['C1', 'C3', 'C5'],
    }))
    expect(result).toEqual(['C1', 'C3', 'C5'])
  })

  it('evaluates nested dot path "domain.entities.count"', async () => {
    const result = await evaluateExpression('domain.entities.count', ctx({
      'domain.entities.count': 7,
    }))
    expect(result).toBe(7)
  })

  // ── includes operator ───────────────────────────────────────────────────

  it('evaluates "route includes C1" to true', async () => {
    expect(await evaluateExpression(
      'route includes C1',
      ctx({ route: ['C1', 'C3', 'C5'] }),
    )).toBe(true)
  })

  it('evaluates "route includes C9" to false', async () => {
    expect(await evaluateExpression(
      'route includes C9',
      ctx({ route: ['C1', 'C3', 'C5'] }),
    )).toBe(false)
  })

  it('evaluates includes on string value', async () => {
    expect(await evaluateExpression(
      'status includes PASS',
      ctx({ status: 'ALL_PASS_OK' }),
    )).toBe(true)
  })

  // ── Logical operators ───────────────────────────────────────────────────

  it('evaluates "x == true and y == true" to true', async () => {
    expect(await evaluateExpression(
      'x == true and y == true',
      ctx({ x: true, y: true }),
    )).toBe(true)
  })

  it('evaluates "x == true and y == true" to false when one is false', async () => {
    expect(await evaluateExpression(
      'x == true and y == true',
      ctx({ x: true, y: false }),
    )).toBe(false)
  })

  it('evaluates "x == true or y == true" to true when one is true', async () => {
    expect(await evaluateExpression(
      'x == true or y == true',
      ctx({ x: false, y: true }),
    )).toBe(true)
  })

  it('evaluates "not x" to false when x is true', async () => {
    expect(await evaluateExpression('not x', ctx({ x: true }))).toBe(false)
  })

  it('evaluates "not x" to true when x is false', async () => {
    expect(await evaluateExpression('not x', ctx({ x: false }))).toBe(true)
  })

  it('accepts uppercase keywords (AND/OR/NOT/INCLUDES)', async () => {
    expect(await evaluateExpression(
      'x == true AND y == true',
      ctx({ x: true, y: true }),
    )).toBe(true)
    expect(await evaluateExpression(
      'x == true OR y == true',
      ctx({ x: false, y: true }),
    )).toBe(true)
    expect(await evaluateExpression('NOT x', ctx({ x: false }))).toBe(true)
    expect(await evaluateExpression(
      'route INCLUDES C1',
      ctx({ route: ['C1', 'C2'] }),
    )).toBe(true)
  })

  it('accepts mixed-case keywords (And/Or)', async () => {
    expect(await evaluateExpression(
      'x == true And y == true Or z == true',
      ctx({ x: true, y: false, z: true }),
    )).toBe(true)
  })

  // ── Built-in functions ──────────────────────────────────────────────────

  it('evaluates "file-exists(domain.md)" to true when file exists', async () => {
    await fs.writeFile(path.join(tmpDir, 'domain.md'), '# Domain')
    expect(await evaluateExpression('file-exists(domain.md)', ctx({}, tmpDir))).toBe(true)
  })

  it('evaluates "file-exists(domain.md)" to false when missing', async () => {
    expect(await evaluateExpression('file-exists(domain.md)', ctx({}, tmpDir))).toBe(false)
  })

  it('evaluates "glob-count(stories/story-*.md)" correctly', async () => {
    await fs.mkdirp(path.join(tmpDir, 'stories'))
    await fs.writeFile(path.join(tmpDir, 'stories', 'story-001.md'), '')
    await fs.writeFile(path.join(tmpDir, 'stories', 'story-002.md'), '')
    await fs.writeFile(path.join(tmpDir, 'stories', 'story-003.md'), '')
    expect(await evaluateExpression('glob-count(stories/story-*.md)', ctx({}, tmpDir))).toBe(3)
  })

  it('evaluates "glob-count(stories/story-*.md)" to 0 when none match', async () => {
    expect(await evaluateExpression('glob-count(missing/*.md)', ctx({}, tmpDir))).toBe(0)
  })

  // ── Eval mode (raw value return) ────────────────────────────────────────

  it('returns raw value for single variable reference', async () => {
    const result = await evaluateExpression('scoping.route', ctx({
      'scoping.route': ['C1', 'C3'],
    }))
    expect(result).toEqual(['C1', 'C3'])
  })

  // ── Edge cases ──────────────────────────────────────────────────────────

  it('handles quoted string values with spaces', async () => {
    expect(await evaluateExpression(
      'status == "in progress"',
      ctx({ status: 'in progress' }),
    )).toBe(true)
  })

  // ── file-content with includes ──────────────────────────────────────────

  it('file-content() includes returns true when content matches', async () => {
    await fs.writeFile(path.join(tmpDir, 'report.md'), '# Report\nStatus: PASS\nAll checks passed')
    const result = await evaluateExpression(
      'file-content(report.md) includes PASS',
      ctx({}, tmpDir),
    )
    expect(result).toBe(true)
  })

  it('file-content() includes returns false when content does not match', async () => {
    await fs.writeFile(path.join(tmpDir, 'report.md'), '# Report\nStatus: FAIL\n2 issues')
    const result = await evaluateExpression(
      'file-content(report.md) includes PASS',
      ctx({}, tmpDir),
    )
    expect(result).toBe(false)
  })

  it('file-content() includes with quoted string containing special chars', async () => {
    await fs.writeFile(path.join(tmpDir, 'arch.md'), '# Architecture\nStatus: APPROVED\n')
    const result = await evaluateExpression(
      'file-content(arch.md) includes "Status: APPROVED"',
      ctx({}, tmpDir),
    )
    expect(result).toBe(true)
  })

  it('not (file-content() includes X) returns true when content does NOT match', async () => {
    await fs.writeFile(path.join(tmpDir, 'report.md'), '# Report\nStatus: PASS\n')
    const result = await evaluateExpression(
      'not (file-content(report.md) includes "FAIL")',
      ctx({}, tmpDir),
    )
    expect(result).toBe(true)
  })

  it('not (file-content() includes X) returns false when content DOES match', async () => {
    await fs.writeFile(path.join(tmpDir, 'report.md'), '# Report\nStatus: FAIL\n')
    const result = await evaluateExpression(
      'not (file-content(report.md) includes "FAIL")',
      ctx({}, tmpDir),
    )
    expect(result).toBe(false)
  })

  // ── glob-count with comparisons ─────────────────────────────────────────

  it('glob-count() > N returns true when enough matches', async () => {
    await fs.mkdirp(path.join(tmpDir, 'stories'))
    await fs.writeFile(path.join(tmpDir, 'stories', 'story-001.md'), '# S1')
    await fs.writeFile(path.join(tmpDir, 'stories', 'story-002.md'), '# S2')
    await fs.writeFile(path.join(tmpDir, 'stories', 'story-003.md'), '# S3')
    const result = await evaluateExpression(
      'glob-count(stories/story-*.md) > 2',
      ctx({}, tmpDir),
    )
    expect(result).toBe(true)
  })

  it('glob-count() > N returns false when not enough matches', async () => {
    await fs.mkdirp(path.join(tmpDir, 'stories'))
    await fs.writeFile(path.join(tmpDir, 'stories', 'story-001.md'), '# S1')
    const result = await evaluateExpression(
      'glob-count(stories/story-*.md) > 2',
      ctx({}, tmpDir),
    )
    expect(result).toBe(false)
  })

  it('glob-count() >= N boundary check', async () => {
    await fs.mkdirp(path.join(tmpDir, 'rules'))
    await fs.writeFile(path.join(tmpDir, 'rules', 'BR-001.yml'), 'id: BR-001')
    await fs.writeFile(path.join(tmpDir, 'rules', 'BR-002.yml'), 'id: BR-002')
    const result = await evaluateExpression(
      'glob-count(rules/BR-*.yml) >= 2',
      ctx({}, tmpDir),
    )
    expect(result).toBe(true)
  })

  // ── Parenthesized grouping ──────────────────────────────────────────────

  it('handles parenthesized or-group: a and (b or c)', async () => {
    const result = await evaluateExpression(
      'x == true and (y == true or z == true)',
      ctx({ x: true, y: false, z: true }),
    )
    expect(result).toBe(true)
  })

  it('parenthesized or-group returns false when outer and fails', async () => {
    const result = await evaluateExpression(
      'x == true and (y == true or z == true)',
      ctx({ x: false, y: false, z: true }),
    )
    expect(result).toBe(false)
  })

  it('parenthesized or-group returns false when inner group all false', async () => {
    const result = await evaluateExpression(
      'x == true and (y == true or z == true)',
      ctx({ x: true, y: false, z: false }),
    )
    expect(result).toBe(false)
  })

  it('handles file-exists and (file-content includes ... or ...)', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"dependencies":{"react":"18"}}')
    const result = await evaluateExpression(
      'file-exists(package.json) and (file-content(package.json) includes "react" or file-content(package.json) includes "vue")',
      ctx({}, tmpDir),
    )
    expect(result).toBe(true)
  })

  it('file-exists and (... or ...) returns false when no match in group', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"dependencies":{"express":"4"}}')
    const result = await evaluateExpression(
      'file-exists(package.json) and (file-content(package.json) includes "react" or file-content(package.json) includes "vue")',
      ctx({}, tmpDir),
    )
    expect(result).toBe(false)
  })

  it('handles multiple or branches inside parens', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"dependencies":{"svelte":"4"}}')
    const result = await evaluateExpression(
      'file-exists(package.json) and (file-content(package.json) includes "react" or file-content(package.json) includes "vue" or file-content(package.json) includes "angular" or file-content(package.json) includes "svelte" or file-content(package.json) includes "next")',
      ctx({}, tmpDir),
    )
    expect(result).toBe(true)
  })

  it('not (a or b) with parens works correctly', async () => {
    const result = await evaluateExpression(
      'not (x == true or y == true)',
      ctx({ x: false, y: false }),
    )
    expect(result).toBe(true)
  })

  it('does not incorrectly strip parens from (a or b) and (c or d)', async () => {
    const result = await evaluateExpression(
      '(x == true or y == true) and (a == true or b == true)',
      ctx({ x: false, y: true, a: true, b: false }),
    )
    expect(result).toBe(true)
  })

  it('(a or b) and (c or d) returns false when one group fails', async () => {
    const result = await evaluateExpression(
      '(x == true or y == true) and (a == true or b == true)',
      ctx({ x: false, y: true, a: false, b: false }),
    )
    expect(result).toBe(false)
  })
})

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ Cross-run expression support (Composite orchestration, schema 3.1)       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

describe('Cross-run namespace (runs.*)', () => {
  const runsCtx = (runs: Record<string, { gates: Record<string, { status: string; at: string; by?: string }>; exports: Record<string, unknown> }>) => ({
    exports: {},
    baseDir: tmpDir,
    runs,
  })

  it('resolves runs.<run>.gates.<gate>.status as identifier', async () => {
    const result = await evaluateExpression(
      'runs.acme--ba.gates.srs-approval-gate.status == "passed"',
      runsCtx({
        'acme--ba': {
          gates: { 'srs-approval-gate': { status: 'passed', at: '2026-05-05T00:00:00Z' } },
          exports: {},
        },
      }),
    )
    expect(result).toBe(true)
  })

  it('returns the literal string when run is not in context', async () => {
    // Without a runs map, the identifier resolves to itself (literal).
    const result = await evaluateExpression(
      'runs.missing.gates.x.status == "passed"',
      { exports: {}, baseDir: tmpDir },
    )
    // Identifier returns "runs.missing.gates.x.status" as literal, which !== "passed"
    expect(result).toBe(false)
  })
})

describe('gate-approved() builtin', () => {
  const runsCtx = (runs: Record<string, { gates: Record<string, { status: string; at: string }>; exports: Record<string, unknown> }>) => ({
    exports: {},
    baseDir: tmpDir,
    runs,
  })

  it('returns true when sibling gate is approved', async () => {
    const result = await evaluateExpression(
      'gate-approved("acme--ba", "srs-approval-gate")',
      runsCtx({
        'acme--ba': {
          gates: { 'srs-approval-gate': { status: 'passed', at: '2026-05-05T00:00:00Z' } },
          exports: {},
        },
      }),
    )
    expect(result).toBe(true)
  })

  it('returns false when sibling run does not exist', async () => {
    const result = await evaluateExpression(
      'gate-approved("acme--missing", "srs-approval-gate")',
      runsCtx({}),
    )
    expect(result).toBe(false)
  })

  it('returns false when gate exists but is not passed', async () => {
    const result = await evaluateExpression(
      'gate-approved("acme--ba", "srs-approval-gate")',
      runsCtx({
        'acme--ba': {
          gates: { 'srs-approval-gate': { status: 'pending', at: '2026-05-05T00:00:00Z' } },
          exports: {},
        },
      }),
    )
    expect(result).toBe(false)
  })

  it('returns false when ctx.runs is undefined', async () => {
    const result = await evaluateExpression(
      'gate-approved("acme--ba", "srs-approval-gate")',
      { exports: {}, baseDir: tmpDir },
    )
    expect(result).toBe(false)
  })

  it('accepts unquoted args (kebab-case run id)', async () => {
    const result = await evaluateExpression(
      'gate-approved(acme--ba, srs-approval-gate)',
      runsCtx({
        'acme--ba': {
          gates: { 'srs-approval-gate': { status: 'passed', at: '2026-05-05T00:00:00Z' } },
          exports: {},
        },
      }),
    )
    expect(result).toBe(true)
  })
})

describe('run-complete() builtin', () => {
  it('returns true when run has _complete marker passed', async () => {
    const result = await evaluateExpression(
      'run-complete("acme--ba")',
      {
        exports: {},
        baseDir: tmpDir,
        runs: {
          'acme--ba': {
            gates: { _complete: { status: 'passed', at: '2026-05-05T00:00:00Z' } },
            exports: {},
          },
        },
      },
    )
    expect(result).toBe(true)
  })

  it('returns false when run has no _complete marker', async () => {
    const result = await evaluateExpression(
      'run-complete("acme--ba")',
      {
        exports: {},
        baseDir: tmpDir,
        runs: {
          'acme--ba': {
            gates: { 'srs-approval-gate': { status: 'passed', at: '2026-05-05T00:00:00Z' } },
            exports: {},
          },
        },
      },
    )
    expect(result).toBe(false)
  })
})

describe('bundle-ready() builtin', () => {
  it('returns true when bundle marker is recorded', async () => {
    const result = await evaluateExpression(
      'bundle-ready("acme--ba", "srs-baseline")',
      {
        exports: {},
        baseDir: tmpDir,
        runs: {
          'acme--ba': {
            gates: { '_bundle:srs-baseline': { status: 'passed', at: '2026-05-05T00:00:00Z' } },
            exports: {},
          },
        },
      },
    )
    expect(result).toBe(true)
  })

  it('returns false when bundle marker is absent', async () => {
    const result = await evaluateExpression(
      'bundle-ready("acme--ba", "srs-baseline")',
      {
        exports: {},
        baseDir: tmpDir,
        runs: {
          'acme--ba': { gates: {}, exports: {} },
        },
      },
    )
    expect(result).toBe(false)
  })
})

describe('evaluateExpression — membership (in / list literals)', () => {
  it('value in [list] — string match', async () => {
    expect(await evaluateExpression('risk in [low, high]', ctx({ risk: 'high' }))).toBe(true)
    expect(await evaluateExpression('risk in [low, medium]', ctx({ risk: 'high' }))).toBe(false)
  })

  it('value in [list] — quoted + numeric elements', async () => {
    expect(await evaluateExpression('sev in ["PHAP_LY", "CANH_BAO"]', ctx({ sev: 'PHAP_LY' }))).toBe(true)
    expect(await evaluateExpression('code in [1, 2, 3]', ctx({ code: 2 }))).toBe(true)
    expect(await evaluateExpression('code in [1, 2, 3]', ctx({ code: 9 }))).toBe(false)
  })

  it('in against a resolved array value (step output)', async () => {
    const c = ctx({ extract: { tags: ['a', 'b'] }, t: 'b' })
    expect(await evaluateExpression('t in extract.tags', c)).toBe(true)
    expect(await evaluateExpression('"z" in extract.tags', c)).toBe(false)
  })

  it('in composes with and/or/not + dotted output paths', async () => {
    const c = ctx({ extract: { risk: 'high', amount: 25 } })
    expect(await evaluateExpression('extract.risk in [high, critical] and extract.amount > 20', c)).toBe(true)
    expect(await evaluateExpression('not (extract.risk in [low, medium])', c)).toBe(true)
  })

  it('empty list never matches', async () => {
    expect(await evaluateExpression('x in []', ctx({ x: 'a' }))).toBe(false)
  })
})

describe('evaluateExpression — defined / empty', () => {
  it('defined(x) reflects presence', async () => {
    expect(await evaluateExpression('defined(extract.risk)', ctx({ extract: { risk: 'high' } }))).toBe(true)
    expect(await evaluateExpression('defined(extract.missing)', ctx({ extract: { risk: 'high' } }))).toBe(false)
  })

  it('empty(x) is true for missing / blank / empty array', async () => {
    expect(await evaluateExpression('empty(extract.note)', ctx({ extract: {} }))).toBe(true)
    expect(await evaluateExpression('empty(extract.note)', ctx({ extract: { note: '' } }))).toBe(true)
    expect(await evaluateExpression('empty(extract.tags)', ctx({ extract: { tags: [] } }))).toBe(true)
    expect(await evaluateExpression('empty(extract.note)', ctx({ extract: { note: 'x' } }))).toBe(false)
  })

  it('defined(x) and ... gates on presence before comparing', async () => {
    const c = ctx({ extract: { risk: 'high' } })
    expect(await evaluateExpression('defined(extract.risk) and extract.risk == high', c)).toBe(true)
  })
})

describe('evaluateExpression — single-quoted strings', () => {
  it("treats 'x' the same as \"x\"", async () => {
    expect(await evaluateExpression("name == 'PASS'", ctx({ name: 'PASS' }))).toBe(true)
    expect(await evaluateExpression("name == 'PASS'", ctx({ name: 'FAIL' }))).toBe(false)
  })
})
