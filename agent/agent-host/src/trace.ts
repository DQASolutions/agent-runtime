// The case ledger — an append-only, hash-chained audit trail of everything that
// happens to one case (Step 2 of the maturity ladder, §6). Every governed write,
// every command-set operation, every gate decision and lifecycle step is one
// line in `.dqa/projects/<tenant>/ledger.jsonl`.
//
// Tamper-evidence (no KMS): each entry carries `hash = sha256(prevHash + body)`,
// where `body` is the canonical (stable-key-order) JSON of the entry WITHOUT its
// own hash. Editing or deleting any line breaks the chain from that point on, so
// verifyLedger() can point an auditor at the exact line that was altered.

import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'fs-extra'

/** `step-failed` = an executor threw; the run continued with what did not depend on it (see Session.drive). */
export type TraceKind = 'read' | 'call' | 'act' | 'note' | 'gate' | 'step' | 'step-failed' | 'denied'

export interface TraceEvent {
  /** 0-based position in the chain. */
  seq: number
  /** ISO 8601 timestamp the entry was appended. */
  at: string
  tenant: string
  /** Workflow task/step this happened under, when known. */
  task?: string
  actor: string
  kind: TraceKind
  /** Action / function / type / op / gate name. */
  name: string
  /** Redactable summary of the inputs (key set or values). */
  args?: unknown
  /** Small summary of the outcome (event count, row count, decision, …). */
  result?: unknown
  provenance?: { source_ref: string; confirmed_by: string; confirmed_at: string }
  /** WHY this decision/step was taken — the human's or agent's stated reason.
   *  Distinct from `result` (WHAT happened): this is the rationale a gate approver
   *  or step gives, the load-bearing "human holds the rules" evidence. Optional;
   *  when absent the entry hashes exactly as before (backward compatible). */
  rationale?: string
  /** Hash of the previous entry; GENESIS for the first. */
  prevHash: string
  /** sha256(prevHash + canonicalJSON(this entry without `hash`)). */
  hash: string
}

/** Fields a caller supplies; seq/at/prevHash/hash are computed by appendTrace. */
export type TraceInput = Omit<TraceEvent, 'seq' | 'at' | 'prevHash' | 'hash'>

const GENESIS = '0'.repeat(64)

export function ledgerPath(tenantDir: string): string {
  return path.join(tenantDir, 'ledger.jsonl')
}

/** Stable, key-sorted JSON so the hash is independent of property order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

function hashEntry(prevHash: string, entry: Omit<TraceEvent, 'hash'>): string {
  return crypto.createHash('sha256').update(prevHash + canonical(entry)).digest('hex')
}

// In-process cache of each ledger's last entry. Without it, `tail` re-reads and
// re-parses the WHOLE ledger on every append → O(n²) over a run (a bulk ingest
// of ~44k governed actions degenerates to minutes of pure ledger I/O). The case
// is single-writer per process, so caching the tail is safe; a fresh process
// reads the file once, then every subsequent append is O(1).
const tailCache = new Map<string, TraceEvent | null>()

/** Append one entry to the case ledger, chaining it to the prior tail. */
export async function appendTrace(tenantDir: string, input: TraceInput): Promise<TraceEvent> {
  await fs.ensureDir(tenantDir)
  const prev = await tail(tenantDir)
  const base: Omit<TraceEvent, 'hash'> = {
    seq: prev ? prev.seq + 1 : 0,
    at: new Date().toISOString(),
    prevHash: prev ? prev.hash : GENESIS,
    ...input,
  }
  const entry: TraceEvent = { ...base, hash: hashEntry(base.prevHash, base) }
  await fs.appendFile(ledgerPath(tenantDir), JSON.stringify(entry) + '\n')
  tailCache.set(ledgerPath(tenantDir), entry) // keep the cached tail in sync
  return entry
}

/** Read the full ledger in order (empty if none yet). */
export async function readLedger(tenantDir: string): Promise<TraceEvent[]> {
  const raw = await fs.readFile(ledgerPath(tenantDir), 'utf-8').catch(() => '')
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceEvent)
}

async function tail(tenantDir: string): Promise<TraceEvent | null> {
  const key = ledgerPath(tenantDir)
  if (tailCache.has(key)) return tailCache.get(key)!
  const all = await readLedger(tenantDir) // first touch this process: read once
  const last = all.length > 0 ? all[all.length - 1]! : null
  tailCache.set(key, last)
  return last
}

export interface LedgerVerdict {
  ok: boolean
  count: number
  /** seq of the first entry whose hash/chain doesn't recompute, if any. */
  brokenAt?: number
}

/** Recompute the whole chain; report the first entry that fails to verify. */
export async function verifyLedger(tenantDir: string): Promise<LedgerVerdict> {
  const all = await readLedger(tenantDir)
  let prevHash = GENESIS
  for (let i = 0; i < all.length; i++) {
    const e = all[i]!
    const { hash, ...body } = e
    if (e.seq !== i || e.prevHash !== prevHash || hashEntry(prevHash, body) !== hash) {
      return { ok: false, count: all.length, brokenAt: e.seq }
    }
    prevHash = hash
  }
  return { ok: true, count: all.length }
}
