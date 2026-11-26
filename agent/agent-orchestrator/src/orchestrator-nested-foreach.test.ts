/**
 * Nested for-each (feature → story) expansion + cascading auto-complete.
 *
 * Covers the increment/vertical-slice topology: an outer for-each over
 * spec/features/*.feature whose sub-tasks include an INNER for-each over that
 * feature's stories, plus per-feature sibling tasks (slice-verify) and a
 * per-feature approval gate. Asserts:
 *   A. nested expansion + two-level id scheme + outer-var interpolation in the
 *      inner source
 *   B. inner-loop rollup feeds a per-feature sibling dep (slice-verify only
 *      becomes ready once all of a feature's stories are done)
 *   C. per-feature gate surfaces as `waiting`, once per feature, in order
 *   D. outer parent completes only after EVERY feature subtree is done
 *   E. parallel-safe inner leaves batch across stories within a feature
 *   F. an inner source matching 0 items surfaces `blocked` (_for-each-empty)
 */
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import type { WorkflowV3 } from './schema-types-v3.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-nf-'))
  await fs.mkdirp(path.join(tmpDir, '.dqa', 'projects', 'p'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

const projectDir = () => path.join(tmpDir, '.dqa', 'projects', 'p')

function orch(wf: WorkflowV3): Orchestrator {
  return new Orchestrator(tmpDir, 'p', wf)
}

/** Create a feature file + its story files under the project's spec tree. */
async function makeFeature(feature: string, stories: string[]): Promise<void> {
  const featPath = path.join(projectDir(), 'spec', 'features', `${feature}.feature`)
  await fs.mkdirp(path.dirname(featPath))
  await fs.writeFile(featPath, `Feature: ${feature}\n  Scenario: happy\n    Given x\n`)
  for (const s of stories) {
    const sp = path.join(projectDir(), 'spec', 'stories', feature, `${s}.md`)
    await fs.mkdirp(path.dirname(sp))
    await fs.writeFile(sp, `# ${s}\nFR-N01: do a thing\n`)
  }
}

/** Write an agent-task's relative output file (so done()'s existence check passes). */
async function writeOut(rel: string): Promise<void> {
  const p = path.join(projectDir(), rel)
  await fs.mkdirp(path.dirname(p))
  await fs.writeFile(p, 'done\n')
}

/** The increment-style nested workflow used by most tests below. */
function nestedWorkflow(): WorkflowV3 {
  return {
    name: 'dev-increment', version: 1,
    pipeline: [{ phase: 'implement' }],
    phases: {
      implement: {
        tasks: [{
          id: 'implement',
          type: 'for-each',
          source: 'spec/features/*.feature',
          as: 'feature',
          'sub-tasks': [
            {
              id: 'stories',
              type: 'for-each',
              source: 'spec/stories/{feature.id}/STORY-*.md',
              as: 'story',
              'sub-tasks': [{
                id: 'backend',
                type: 'agent-task',
                'parallel-safe': true,
                output: 'build/{feature.id}/{story.id}/backend.md',
                instruction: 'impl backend for {feature.id}/{story.id}',
              }],
            },
            {
              id: 'slice-verify',
              type: 'agent-task',
              depends: ['stories'],
              output: 'build/{feature.id}/verify.md',
              instruction: 'verify {feature.id}',
            },
            {
              id: 'feature-accept-gate',
              type: 'gate',
              'gate-type': 'approval',
              depends: ['slice-verify'],
              description: 'Accept feature {feature.id}',
            },
          ],
        }],
      },
    },
  } as unknown as WorkflowV3
}

// ── A. nested expansion + id scheme + outer-var interpolation ────────────────

describe('nested for-each expands feature→story with a two-level id', () => {
  it('first task is the inner leaf, id prefixed feature:stories:story', async () => {
    await makeFeature('auth', ['STORY-001', 'STORY-002'])
    await makeFeature('payment', ['STORY-001'])
    const o = orch(nestedWorkflow())
    const r = await o.start()

    expect(r.status).toBe('next')
    if (r.status !== 'next') return
    // Features glob sorted → auth before payment; stories sorted → 001 first.
    // Inner source {feature.id} resolved to 'auth' to find the right stories.
    expect(r.task).toBe('implement:auth:stories:STORY-001:backend')
    expect(r.instruction).toContain('auth/STORY-001')
  })
})

// ── E. parallel-safe inner leaves batch across stories within a feature ──────

describe('parallel-safe inner leaves batch within a feature', () => {
  it('nextBatch returns both auth stories backend together, not slice-verify', async () => {
    await makeFeature('auth', ['STORY-001', 'STORY-002'])
    const o = orch(nestedWorkflow())
    await o.start()
    const r = await o.nextBatch(5)

    expect(r.status).toBe('next-batch')
    if (r.status !== 'next-batch') return
    const ids = r.tasks.map(t => t.task).sort()
    expect(ids).toEqual([
      'implement:auth:stories:STORY-001:backend',
      'implement:auth:stories:STORY-002:backend',
    ])
  })
})

// ── B/C/D. full drive: rollup feeds sibling, gate per feature, outer last ────

describe('nested for-each: rollup, per-feature gate, ordered completion', () => {
  it('drives two features to completion through their accept gates', async () => {
    await makeFeature('auth', ['STORY-001', 'STORY-002'])
    await makeFeature('payment', ['STORY-001', 'STORY-002'])
    const o = orch(nestedWorkflow())

    const waitingGates: string[] = []

    // Helper: complete an agent-task by id (write its output, then done()).
    async function completeBackend(feature: string, story: string): Promise<void> {
      await writeOut(`build/${feature}/${story}/backend.md`)
      await o.done(`implement:${feature}:stories:${story}:backend`)
    }

    // auth: two backends
    let r = await o.start()
    expect(r.status).toBe('next')

    await completeBackend('auth', 'STORY-001')
    await completeBackend('auth', 'STORY-002')

    // B: after both auth stories done, the inner 'stories' marker rolled up,
    // so the per-feature sibling slice-verify is now the ready task.
    r = await o.next()
    expect(r.status).toBe('next')
    if (r.status === 'next') expect(r.task).toBe('implement:auth:slice-verify')

    await writeOut('build/auth/verify.md')
    r = await o.done('implement:auth:slice-verify')

    // C: auth accept gate surfaces as waiting with the feature in its text.
    expect(r.status).toBe('waiting')
    if (r.status === 'waiting') {
      waitingGates.push(r.gate)
      expect(r.description).toContain('auth')
    }
    r = await o.approve('implement:auth:feature-accept-gate')

    // D: auth is done but the OUTER 'implement' is NOT — payment still pending.
    // The next ready task is payment's first story, not completion.
    expect(r.status).toBe('next')
    if (r.status === 'next') expect(r.task).toBe('implement:payment:stories:STORY-001:backend')

    // payment: two backends → slice-verify → gate
    await completeBackend('payment', 'STORY-001')
    await completeBackend('payment', 'STORY-002')

    r = await o.next()
    expect(r.status).toBe('next')
    if (r.status === 'next') expect(r.task).toBe('implement:payment:slice-verify')
    await writeOut('build/payment/verify.md')
    r = await o.done('implement:payment:slice-verify')

    expect(r.status).toBe('waiting')
    if (r.status === 'waiting') {
      waitingGates.push(r.gate)
      expect(r.description).toContain('payment')
    }
    r = await o.approve('implement:payment:feature-accept-gate')

    // D: now every feature subtree is done → outer 'implement' completes →
    // phase complete → workflow complete.
    expect(r.status).toBe('complete')

    // C: exactly one gate per feature, in feature order.
    expect(waitingGates).toEqual([
      'implement:auth:feature-accept-gate',
      'implement:payment:feature-accept-gate',
    ])
  })
})

// ── G. gate INSIDE the inner loop resolves feature+story vars (mirrors the
//      real dqa-dev plan-gate nested under the story loop) ────────────────────

describe('a gate inside the inner story loop surfaces with merged vars', () => {
  it('inner-loop gate description resolves both {feature.id} and {story.id}', async () => {
    await makeFeature('payment', ['STORY-001'])
    const wf = {
      name: 'dev-inner-gate', version: 1,
      pipeline: [{ phase: 'implement' }],
      phases: {
        implement: {
          tasks: [{
            id: 'implement',
            type: 'for-each',
            source: 'spec/features/*.feature',
            as: 'feature',
            'sub-tasks': [{
              id: 'stories',
              type: 'for-each',
              source: 'spec/stories/{feature.id}/STORY-*.md',
              as: 'story',
              'sub-tasks': [
                {
                  id: 'plan-gate',
                  type: 'gate',
                  'gate-type': 'approval',
                  description: 'Plan for {feature.id}/{story.id}',
                },
                {
                  id: 'backend',
                  type: 'agent-task',
                  depends: ['plan-gate'],
                  output: 'build/{feature.id}/{story.id}/be.md',
                  instruction: 'build {story.id}',
                },
              ],
            }],
          }],
        },
      },
    } as unknown as WorkflowV3
    const o = orch(wf)
    const r = await o.start()

    // First ready item is the inner-loop gate, with both vars resolved.
    expect(r.status).toBe('waiting')
    if (r.status !== 'waiting') return
    expect(r.gate).toBe('implement:payment:stories:STORY-001:plan-gate')
    expect(r.description).toBe('Plan for payment/STORY-001')

    // Approving it unblocks the gated inner leaf.
    const r2 = await o.approve('implement:payment:stories:STORY-001:plan-gate')
    expect(r2.status).toBe('next')
    if (r2.status === 'next') expect(r2.task).toBe('implement:payment:stories:STORY-001:backend')
  })
})

// ── F. empty inner source → blocked (_for-each-empty) ────────────────────────

describe('nested for-each with no inner matches blocks, not completes', () => {
  it('a feature with zero stories surfaces _for-each-empty', async () => {
    // Feature file exists but NO spec/stories/solo/ dir → inner glob = 0.
    const featPath = path.join(projectDir(), 'spec', 'features', 'solo.feature')
    await fs.mkdirp(path.dirname(featPath))
    await fs.writeFile(featPath, 'Feature: solo\n  Scenario: x\n    Given y\n')

    const o = orch(nestedWorkflow())
    const r = await o.start()

    expect(r.status).toBe('blocked')
    if (r.status === 'blocked') expect(r.gate).toBe('_for-each-empty')
  })
})
