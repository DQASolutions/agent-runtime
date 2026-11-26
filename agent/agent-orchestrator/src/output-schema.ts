import type { OutputTypeSpec, OutputsDecl } from './schema-types-v3.js'

/**
 * Validation of a step's declared structured outputs.
 *
 * Generic + recursive: one `validateValue` walk handles every shape
 * (scalars · enum · object · array · optional). Adding a new output kind means
 * extending {@link OutputTypeSpec} + one `case` here — never touching callers.
 *
 * Values are sourced from whatever the producing step provided (the output
 * file's YAML frontmatter and/or the `dqa done --exports` payload). A field may
 * be supplied bare (`amount: …`) or under the step-id namespace
 * (`<step-id>: { amount: … }`); both resolve. The result is the canonical,
 * validated value map stored per-step in run state.
 */

export interface OutputValidationError {
  /** Dotted path to the offending value, e.g. `finding.severity` or `rows[2].id`. */
  path: string
  message: string
}

export interface OutputValidationResult {
  ok: boolean
  /** Validated values for the declared fields (omits absent optionals). */
  values: Record<string, unknown>
  errors: OutputValidationError[]
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function validateValue(
  spec: OutputTypeSpec,
  value: unknown,
  path: string,
  errors: OutputValidationError[],
): unknown {
  if (value === undefined || value === null) {
    if (spec.optional) return undefined
    errors.push({ path, message: `required output "${path}" is missing` })
    return undefined
  }

  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') errors.push({ path, message: `expected string, got ${typeName(value)}` })
      return value
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push({ path, message: `expected number, got ${typeName(value)}` })
      return value
    case 'boolean':
      if (typeof value !== 'boolean') errors.push({ path, message: `expected boolean, got ${typeName(value)}` })
      return value
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push({ path, message: `expected one of [${spec.values.join(', ')}], got ${JSON.stringify(value)}` })
      }
      return value
    case 'object': {
      if (typeName(value) !== 'object') {
        errors.push({ path, message: `expected object, got ${typeName(value)}` })
        return value
      }
      const obj = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const [field, sub] of Object.entries(spec.fields)) {
        const v = validateValue(sub, obj[field], path ? `${path}.${field}` : field, errors)
        if (v !== undefined) out[field] = v
      }
      return out
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ path, message: `expected array, got ${typeName(value)}` })
        return value
      }
      return value.map((item, i) => validateValue(spec.items, item, `${path}[${i}]`, errors))
    }
    default: {
      // Exhaustiveness guard — a new OutputTypeSpec variant without a case here
      // is a compile error, not a silent pass.
      const _exhaustive: never = spec
      errors.push({ path, message: `unknown output type` })
      return _exhaustive
    }
  }
}

/**
 * Validate the values a step produced against its declared `outputs`.
 *
 * @param decl     the step's `outputs:` declaration
 * @param provided merged source values (frontmatter + --exports)
 * @param stepId   used to also look for values under a `<stepId>` namespace
 */
export function validateOutputs(
  decl: OutputsDecl,
  provided: Record<string, unknown>,
  stepId: string,
): OutputValidationResult {
  const errors: OutputValidationError[] = []
  const values: Record<string, unknown> = {}

  const nsRaw = provided[stepId]
  const ns = nsRaw && typeof nsRaw === 'object' && !Array.isArray(nsRaw) ? (nsRaw as Record<string, unknown>) : {}

  for (const [field, spec] of Object.entries(decl)) {
    const raw = field in provided ? provided[field] : ns[field]
    const v = validateValue(spec, raw, field, errors)
    if (v !== undefined) values[field] = v
  }

  return { ok: errors.length === 0, values, errors }
}

/** Format validation errors into a single, agent-actionable message. */
export function formatOutputErrors(stepId: string, errors: OutputValidationError[]): string {
  const lines = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')
  return (
    `Declared outputs for task "${stepId}" failed validation:\n${lines}\n` +
    `Provide them in the output file's YAML frontmatter, or via ` +
    `\`dqa done ${stepId} --exports '{"<field>": <value>}'\`.`
  )
}
