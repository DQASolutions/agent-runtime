// Pure-function tests for the extract→ingest pre-flight validator. Builds an
// OntologySchema directly (no live port needed) and asserts every error class is
// caught, with its dotted path, and that a clean payload passes.
import { describe, it, expect } from 'vitest'
import type { OntologySchema } from '@dqa-ai-solutions/ontology-runtime'
import { validateIngestPayload } from './ingest-payload-validator.js'

const schema: OntologySchema = {
  entityTypes: [
    {
      name: 'customer',
      label: 'Customer',
      properties: [
        { name: 'name', type: 'text', required: true },
        { name: 'pep', type: 'enum', enumValues: ['yes', 'no'] },
        { name: 'score', type: 'number' },
      ],
    },
    { name: 'account', label: 'Account', properties: [{ name: 'ref', type: 'text' }] },
  ],
  relationshipTypes: [{ name: 'owns', from: 'customer', to: 'account', cardinality: 'N..N', directed: true }],
}

describe('validateIngestPayload', () => {
  it('passes a well-formed payload', () => {
    const res = validateIngestPayload(
      {
        instances: [
          { type: 'customer', ref: 'c', props: { name: 'Acme', pep: 'no', score: 42 } },
          { type: 'account', ref: 'a', props: { ref: 'ACC-1' } },
        ],
        links: [{ relationship: 'owns', from: 'c', to: 'a' }],
      },
      schema,
    )
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
  })

  it('flags an unknown entity type', () => {
    const res = validateIngestPayload({ instances: [{ type: 'vendor', props: {} }] }, schema)
    expect(res.ok).toBe(false)
    expect(res.errors).toEqual([
      expect.objectContaining({ path: 'instances[0].type', code: 'UNKNOWN_ENTITY_TYPE' }),
    ])
  })

  it('flags a missing required property, a type mismatch, an unknown property, and a bad enum — all at once', () => {
    const res = validateIngestPayload(
      { instances: [{ type: 'customer', props: { score: 'high', extra: 1, pep: 'maybe' } }] },
      schema,
    )
    const byCode = Object.fromEntries(res.errors.map((e) => [e.code, e.path]))
    expect(res.ok).toBe(false)
    expect(byCode['TYPE_MISMATCH']).toBe('instances[0].props.score')
    expect(byCode['UNKNOWN_PROPERTY']).toBe('instances[0].props.extra')
    expect(byCode['ENUM_VALUE_INVALID']).toBe('instances[0].props.pep')
    expect(byCode['REQUIRED_PROPERTY_MISSING']).toBe('instances[0].props.name')
  })

  it('flags an unknown relationship', () => {
    const res = validateIngestPayload(
      { instances: [{ type: 'customer', ref: 'c', props: { name: 'A' } }], links: [{ relationship: 'pays', from: 'c', to: 'c' }] },
      schema,
    )
    expect(res.errors).toEqual([
      expect.objectContaining({ path: 'links[0].relationship', code: 'UNKNOWN_RELATIONSHIP_TYPE' }),
    ])
  })

  it('flags an endpoint type mismatch when the ref resolves to the wrong entity type', () => {
    const res = validateIngestPayload(
      {
        instances: [
          { type: 'customer', ref: 'c', props: { name: 'A' } },
          { type: 'account', ref: 'a', props: {} },
        ],
        // owns is customer→account; here from/to are swapped.
        links: [{ relationship: 'owns', from: 'a', to: 'c' }],
      },
      schema,
    )
    expect(res.ok).toBe(false)
    expect(res.errors.map((e) => e.path).sort()).toEqual(['links[0].from', 'links[0].to'])
    expect(res.errors.every((e) => e.code === 'ENDPOINT_TYPE_MISMATCH')).toBe(true)
  })

  it('does not type-check endpoints that reference an existing id (not a local ref)', () => {
    const res = validateIngestPayload(
      { links: [{ relationship: 'owns', from: 'existing-id-1', to: 'existing-id-2' }] },
      schema,
    )
    // Relationship is known; endpoints are ids resolved at write time → no error.
    expect(res.ok).toBe(true)
  })
})
