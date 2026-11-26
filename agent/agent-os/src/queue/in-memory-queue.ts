// InMemoryQueue — slice A WorkQueue impl: priority + coalescing + optional
// aging. Correctness over speed (linear-scan pop is fine here; a heap is
// premature). Lost on restart — that's accepted for slice A; the durable
// pg/redis impl behind the same port handles persistence later.

import type { Intent } from '../ports/intent.js'
import type { EnqueueOpts, WorkQueue } from '../ports/work-queue.js'

interface Slot {
  intent: Intent
  priority: number
  key?: string
  /** Insertion order — FIFO tiebreak within equal effective priority. */
  seq: number
  /** Enqueue time (ms) — for aging. */
  enqueuedAt: number
}

export interface InMemoryQueueOpts {
  /** Effective priority gains `agingRate` per ms waited, so a long-waiting
   *  low-priority item eventually overtakes fresh higher ones (anti-starvation).
   *  Default 0 = OFF (deterministic; slice A runs with aging off). */
  agingRate?: number
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number
}

export class InMemoryQueue implements WorkQueue {
  private readonly pending: Slot[] = []
  private readonly byKey = new Map<string, Slot>()
  private seq = 0
  private readonly agingRate: number
  private readonly now: () => number

  constructor(opts: InMemoryQueueOpts = {}) {
    this.agingRate = opts.agingRate ?? 0
    this.now = opts.now ?? (() => Date.now())
  }

  async enqueue(intent: Intent, opts: EnqueueOpts): Promise<void> {
    const { priority, key } = opts
    if (key !== undefined) {
      const existing = this.byKey.get(key)
      if (existing) {
        // Coalesce: collapse onto the existing slot. Latest payload wins (newest
        // data), most-urgent priority wins (escalation never lost).
        existing.intent = intent
        existing.priority = Math.max(existing.priority, priority)
        return
      }
    }
    const slot: Slot = { intent, priority, key, seq: this.seq++, enqueuedAt: this.now() }
    this.pending.push(slot)
    if (key !== undefined) this.byKey.set(key, slot)
  }

  async popHighest(): Promise<Intent | null> {
    if (this.pending.length === 0) return null
    const t = this.now()
    let bestIdx = 0
    let bestEff = this.effective(this.pending[0], t)
    for (let i = 1; i < this.pending.length; i++) {
      const eff = this.effective(this.pending[i], t)
      // Higher effective priority wins; tie → lower seq (FIFO, fair).
      if (eff > bestEff || (eff === bestEff && this.pending[i].seq < this.pending[bestIdx].seq)) {
        bestEff = eff
        bestIdx = i
      }
    }
    const [slot] = this.pending.splice(bestIdx, 1)
    if (slot.key !== undefined) this.byKey.delete(slot.key)
    return slot.intent
  }

  async markDone(_intentId: string): Promise<void> {
    // In-memory: popHighest already removed the item. Durable impls ack here.
  }

  size(): number {
    return this.pending.length
  }

  private effective(s: Slot, now: number): number {
    return this.agingRate === 0 ? s.priority : s.priority + (now - s.enqueuedAt) * this.agingRate
  }
}
