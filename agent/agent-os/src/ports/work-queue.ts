// WorkQueue — the kernel's SINGLE async front door (os-runtime-design.md §3 ①).
// A port: slice A ships an in-memory impl; a durable impl (pg/redis) snaps in
// later WITHOUT touching the core (same interface). The queue's job is flow
// control — priority, coalescing, defer-not-drop — NOT durability of state
// (that's the event-sourced run store).

import type { Intent } from './intent.js'

export interface EnqueueOpts {
  /** Higher = more urgent. Comes from the intent's source (severity / SLA / tier). */
  priority: number
  /** Coalescing key. A second enqueue with the same key COLLAPSES onto the first
   *  (latest payload wins, most-urgent priority wins) — so a burst of redundant
   *  intents (e.g. 100× "re-check entity X") becomes one unit of work. */
  key?: string
}

export interface WorkQueue {
  /** Submit work. Coalesces by `opts.key` when present. */
  enqueue(intent: Intent, opts: EnqueueOpts): Promise<void>
  /** Claim the most-urgent ready intent (priority, then FIFO), or null if empty. */
  popHighest(): Promise<Intent | null>
  /** Ack a claimed intent. In-memory: no-op (popHighest already removed it);
   *  durable impls use this to complete a claim (crash-safe at-least-once). */
  markDone(intentId: string): Promise<void>
  /** Number of pending (un-popped) intents. */
  size(): number
}
