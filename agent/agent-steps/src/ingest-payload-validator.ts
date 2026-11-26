// Pre-flight validation for the extract → ingest handoff. An IngestPayload is
// often produced by an LLM extractor skill, so it is the least-trusted seam in
// the chain. This validates the WHOLE payload against the installed ontology
// schema BEFORE `ingest` writes anything — collecting every error (not just the
// first) so a malformed extraction surfaces in one clear report, atomically,
// instead of half-writing the graph and failing deep inside a later action.
//
// This is GENERIC kernel validation: it asserts only that the payload conforms
// to whatever ontology the APP declared (types exist, props match their declared
// types/enums/required, link endpoints match the relationship). It encodes no
// app-specific business rule — those belong in the app's rules.json /
// `evaluate-rules`. Property validation reuses `collectInstanceDataErrors`, the
// same definition of "valid" the write-time guard uses, so the two never drift.

import {
  collectInstanceDataErrors,
  type OntologySchema,
  type OntologyErrorCode,
} from '@dqa-ai-solutions/core-runtime'
import type { IngestPayload } from './executors.js'

export interface PayloadValidationError {
  /** Dotted path into the payload, e.g. `instances[2].props.amount`. */
  path: string
  code: OntologyErrorCode
  message: string
}

export interface PayloadValidationResult {
  ok: boolean
  errors: PayloadValidationError[]
}

/** Strip the `[CODE] ` prefix OntologyError prepends, so we don't double-tag. */
function bareMessage(message: string): string {
  return message.replace(/^\[[A-Z_]+\]\s*/, '')
}

/**
 * Validate an IngestPayload against the installed ontology schema. Returns every
 * problem found (empty `errors` ⇒ valid). Checks:
 *   - each instance `type` is a declared entity type
 *   - instance `props` conform to the entity type (type · enum · required ·
 *     unknown-property), via {@link collectInstanceDataErrors}
 *   - each link `relationship` is a declared relationship type
 *   - link endpoints that resolve to a local `ref` match the relationship's
 *     declared `from` / `to` entity types
 *
 * Cardinality is NOT checked here — it needs the existing edges and is enforced
 * at write time. Endpoints that reference an existing instance id (not a local
 * `ref`) are left for the write door, which resolves and type-checks them.
 */
export function validateIngestPayload(payload: IngestPayload, schema: OntologySchema): PayloadValidationResult {
  const errors: PayloadValidationError[] = []
  const entityTypes = new Map(schema.entityTypes.map((e) => [e.name, e]))
  const relationshipTypes = new Map(schema.relationshipTypes.map((r) => [r.name, r]))
  const refType = new Map<string, string>() // local ref → entity type (only for valid instances)

  const instances = payload.instances ?? []
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]
    const base = `instances[${i}]`
    const et = entityTypes.get(inst.type)
    if (!et) {
      errors.push({
        path: `${base}.type`,
        code: 'UNKNOWN_ENTITY_TYPE',
        message: `EntityType "${inst.type}" is not defined in the ontology`,
      })
      continue
    }
    for (const err of collectInstanceDataErrors(et, inst.props ?? {}, { partial: false })) {
      const prop = err.details?.property as string | undefined
      errors.push({
        path: prop ? `${base}.props.${prop}` : `${base}.props`,
        code: err.code,
        message: bareMessage(err.message),
      })
    }
    if (inst.ref) refType.set(inst.ref, inst.type)
  }

  const links = payload.links ?? []
  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    const base = `links[${i}]`
    const rt = relationshipTypes.get(link.relationship)
    if (!rt) {
      errors.push({
        path: `${base}.relationship`,
        code: 'UNKNOWN_RELATIONSHIP_TYPE',
        message: `RelationshipType "${link.relationship}" is not defined in the ontology`,
      })
      continue
    }
    // Only endpoints given as a local ref can be type-checked pre-flight; an
    // endpoint that is an existing instance id is resolved at write time.
    const fromType = refType.get(link.from)
    if (fromType && fromType !== rt.from) {
      errors.push({
        path: `${base}.from`,
        code: 'ENDPOINT_TYPE_MISMATCH',
        message: `Link "${link.relationship}" expects from "${rt.from}" but ref "${link.from}" is "${fromType}"`,
      })
    }
    const toType = refType.get(link.to)
    if (toType && toType !== rt.to) {
      errors.push({
        path: `${base}.to`,
        code: 'ENDPOINT_TYPE_MISMATCH',
        message: `Link "${link.relationship}" expects to "${rt.to}" but ref "${link.to}" is "${toType}"`,
      })
    }
  }

  return { ok: errors.length === 0, errors }
}

/** A pre-flight failure carrying every payload error, for a clear blocked checkpoint. */
export class IngestValidationError extends Error {
  readonly errors: PayloadValidationError[]
  constructor(errors: PayloadValidationError[]) {
    super(
      `Ingest payload failed validation (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
        errors.map((e) => `  - ${e.path}: [${e.code}] ${e.message}`).join('\n'),
    )
    this.name = 'IngestValidationError'
    this.errors = errors
  }
}
