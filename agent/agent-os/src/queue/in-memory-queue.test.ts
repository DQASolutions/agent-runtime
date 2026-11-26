import { describe, it, expect } from 'vitest'
import { InMemoryQueue } from './in-memory-queue.js'
import type { Intent, SpawnRunIntent } from '../ports/intent.js'

// Helper: a minimal spawn-run intent with a given id.
function spawn(id: string, seed: Record<string, unknown> = {}): SpawnRunIntent {
  return { id, kind: 'spawn-run', tenant: 'default', app: 'demo', depth: 1, workflow: 'demo:review', seed }
}

async function drainAll(q: InMemoryQueue): Promise<Intent[]> {
  const out: Intent[] = []
  for (;;) {
    const i = await q.popHighest()
    if (!i) break
    out.push(i)
  }
  return out
}

describe('InMemoryQueue — priority (DoD C)', () => {
  it('pops highest priority first; ties FIFO', async () => {
    const q = new InMemoryQueue()
    await q.enqueue(spawn('low'), { priority: 1, key: 'k-low' })
    await q.enqueue(spawn('high'), { priority: 9, key: 'k-high' })
    await q.enqueue(spawn('mid'), { priority: 5, key: 'k-mid' })

    const order = (await drainAll(q)).map((i) => i.id)
    expect(order).toEqual(['high', 'mid', 'low'])
  })

  it('breaks priority ties by insertion order (FIFO)', async () => {
    const q = new InMemoryQueue()
    await q.enqueue(spawn('first'), { priority: 5, key: 'a' })
    await q.enqueue(spawn('second'), { priority: 5, key: 'b' })
    await q.enqueue(spawn('third'), { priority: 5, key: 'c' })

    const order = (await drainAll(q)).map((i) => i.id)
    expect(order).toEqual(['first', 'second', 'third'])
  })
})

describe('InMemoryQueue — coalescing (DoD B at queue level)', () => {
  it('100 enqueues of the same key collapse to ONE intent', async () => {
    const q = new InMemoryQueue()
    for (let n = 0; n < 100; n++) {
      await q.enqueue(spawn(`gen-${n}`, { n }), { priority: 1, key: 'same-target' })
    }
    expect(q.size()).toBe(1)

    const drained = await drainAll(q)
    expect(drained).toHaveLength(1)
  })

  it('coalesce keeps latest payload and most-urgent priority', async () => {
    const q = new InMemoryQueue()
    await q.enqueue(spawn('v1', { v: 1 }), { priority: 2, key: 'k' })
    await q.enqueue(spawn('v2', { v: 2 }), { priority: 7, key: 'k' }) // higher prio, newer
    await q.enqueue(spawn('v3', { v: 3 }), { priority: 4, key: 'k' }) // lower prio, newest

    // Add a competitor below the escalated priority to verify the coalesced
    // slot kept priority 7 (so it wins).
    await q.enqueue(spawn('other'), { priority: 6, key: 'other' })

    const drained = await drainAll(q)
    expect(drained.map((i) => i.id)).toEqual(['v3', 'other'])
    expect((drained[0] as SpawnRunIntent).seed).toEqual({ v: 3 }) // latest payload won
  })

  it('a popped key can be enqueued again (key freed on pop)', async () => {
    const q = new InMemoryQueue()
    await q.enqueue(spawn('a'), { priority: 1, key: 'k' })
    expect(await q.popHighest()).not.toBeNull()
    await q.enqueue(spawn('b'), { priority: 1, key: 'k' })
    expect(q.size()).toBe(1)
  })
})

describe('InMemoryQueue — keyless + aging', () => {
  it('keyless intents never coalesce', async () => {
    const q = new InMemoryQueue()
    await q.enqueue(spawn('x1'), { priority: 1 })
    await q.enqueue(spawn('x2'), { priority: 1 })
    expect(q.size()).toBe(2)
  })

  it('aging lets an old low-priority item overtake a fresh higher one', async () => {
    let clock = 0
    const q = new InMemoryQueue({ agingRate: 1, now: () => clock })
    await q.enqueue(spawn('old-low'), { priority: 1, key: 'a' }) // enqueuedAt 0
    clock = 100
    await q.enqueue(spawn('fresh-high'), { priority: 50, key: 'b' }) // enqueuedAt 100
    // At t=200: old-low eff = 1 + 200 = 201; fresh-high eff = 50 + 100 = 150.
    clock = 200
    const first = await q.popHighest()
    expect(first?.id).toBe('old-low')
  })

  it('empty queue returns null', async () => {
    const q = new InMemoryQueue()
    expect(await q.popHighest()).toBeNull()
  })
})
