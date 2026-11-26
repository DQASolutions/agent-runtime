#!/usr/bin/env node
// dqa-fos — the SOLE CLI a Claude Code session drives an app with. Groups:
//
// All session/command-set ops take an OPTIONAL --tenant <id> (default 'default')
// that namespaces the run's state + ontology data. Omit it for the simple model
// "the os runs the app"; pass it only to keep multiple cases/periods isolated.
//
// SESSION (drive the workflow):
//   dqa-fos start --app <dir> --workspace <dir> [--tenant <id>] [--workflow <name>] [--input <json> | --input-file <path>]
//     --workflow selects among the app's workflow*.yaml by `name:` (default: workflow.yaml).
//     The name is persisted in _run.yaml, so done/approve/status resume the same one.
//   dqa-fos done  <task>  [--exports <json>] [--workflow <name>]
//   dqa-fos approve <gate>                   [--workflow <name>]
//   dqa-fos status                           [--workflow <name>]
//     no --workflow on a tenant with several run logs ⇒ a summary of EVERY run (`runs[]`).
//   dqa-fos reset                              (DESTRUCTIVE: wipe graph + EVERY run log of the
//     tenant, archive ledger, so the next `start` loads clean; sources/ are kept)
//   dqa-fos new-round [--workflow <name>]      (clear ONE run log, KEEP the graph, archive ledger →
//     next `start` begins a fresh run over the same data; other workflows' runs are untouched)
//
// ONE RUN LOG PER RUN. Naming a workflow gives it its OWN log at
// `.dqa/state/<tenant>--<workflow>/`; omitting it uses the legacy shared
// `.dqa/state/<tenant>/` — so single-workflow apps keep working unchanged. On a tenant that
// already has per-run logs, a WRITING op (start/done/approve/new-round) with no run
// selected FAILS LOUDLY rather than guessing: writing to the wrong log marks work done where
// nothing reads it, and the workflow then hangs with no symptom.
//
// `--run <key>` NAMES THE LOG, `--workflow <name>` NAMES THE DEFINITION. Two runs of the SAME
// workflow on the SAME tenant need two keys — otherwise they share one log, and the second's
// `new-round` wipes what the first is still writing (silent, no error). Key it by the job:
//   dqa-fos start --workflow ke-toan-advisory --run ke-toan-advisory.job-3f7a91c2 …
// Omit `--run` and the log is named after the workflow, exactly as before.
// The run may also come from env `DQA_RUN` (which OUTRANKS `--workflow`) — so every dqa-fos
// call inside one AI session targets that session's log without touching any prompt or skill.
// Per-job logs accumulate: `drop-run --run <key>` removes one when the job's result is banked.
//
// WHO HOLDS A RUN (optional, for multi-process setups): `--owner <token>` (env `DQA_OWNER`)
// takes/renews a lease on the run log. A different owner is REFUSED while the lease is fresh —
// two drivers on one log interleave events and corrupt progress. A lease older than the ttl
// (`DQA_LEASE_TTL_MS`, default 60m) is treated as a dead driver and taken over, which is also
// how a HUNG run becomes detectable (`status` reports `heldBy.stale`). Omit `--owner` and no
// lease is taken at all — single-process apps behave exactly as before.
// The lease is RELEASED when the run reaches `complete`, and by `dqa-fos release` when a job is
// abandoned — so the next job on that log starts immediately under its OWN owner token instead
// of waiting out the ttl. That is what lets every job carry a distinct owner, which is what
// makes the lease able to tell two drivers apart at all.
//
// COMMAND-SET (the ONLY door to the ontology, used DURING an agent/investigate step):
//   dqa-fos query <type> [whereJson]
//   dqa-fos get   <id>
//   dqa-fos call  <fn> [argsJson]
//   dqa-fos act   <action> [paramsJson]
//   dqa-fos note  <id> <text>
//
// AUDIT (verify + read the tamper-evident case ledger):
//   dqa-fos trace --workspace <dir> [--tenant <id>]
//
// All output is JSON on stdout. A session surfaces an `agent` checkpoint (playbook
// + tools + flaggedIds in exports); Claude Code then reasons, runs call/act, and
// calls `done` — the investigation loop IS the Claude Code session, not hard code.

import fs from 'fs-extra'
import path from 'node:path'
import { CommandSet } from './command-set.js'
import { FieldSession } from './session.js'
import { readLedger, verifyLedger } from './trace.js'

function parse(argv: string[]): { op?: string; pos: string[]; flags: Record<string, string> } {
  const op = argv[0]
  const pos: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) flags[a.slice(2)] = argv[++i]
    else pos.push(a)
  }
  return { op, pos, flags }
}

const json = (s?: string) => (s ? (JSON.parse(s) as Record<string, never>) : undefined)
const out = (v: unknown): void => {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n')
}

const SESSION_OPS = new Set(['start', 'done', 'approve', 'status'])
const MGMT_OPS = new Set(['reset', 'new-round', 'release', 'drop-run'])
const CS_OPS = new Set(['query', 'get', 'call', 'act', 'note'])

/** Usage text for `dqa-fos` / `dqa-fos --help` / `dqa-fos help`. Mirrors the
 *  command groups in the file header so a bare invocation is self-documenting
 *  instead of erroring with "missing --app". */
const HELP = `dqa-fos — the single CLI a Claude Code session drives a FieldOS app with.

Usage: dqa-fos <command> [args] [--flags]

Session (drive the workflow — need --app <dir> --workspace <dir>; optional --tenant <id>):
  start [--workflow <name>] [--run <key>] [--input <json> | --input-file <path>]
                                         begin OR resume a run; returns the current checkpoint
                                         --run names the LOG (one per job) so the same workflow
                                         can run many times in parallel; default: the workflow name
  done <task> [--exports <json>]         record an agent step's result, continue
  approve <gate>                         approve a gate, continue
  status                                 show the run's current exports
  reset                                  DESTRUCTIVE: wipe graph + state, archive ledger
  new-round                              clear the run, KEEP the graph (next start runs fresh over same data)
  release                                give up the lease on a run you abandoned (complete releases it for you)
  drop-run --run <key>                   remove ONE finished run log (keeps graph + ledger)

Command-set (the only door to the ontology, used during an agent step):
  query <type> [whereJson]               get <id>
  call  <fn> [argsJson]                  act <action> [paramsJson] [--actor <who>]
  note  <id> <text>

Audit:
  trace --workspace <dir> [--tenant <id>]   verify + dump the case ledger

All output is JSON on stdout.`

async function readInput(flags: Record<string, string>): Promise<string | undefined> {
  if (flags['input-file']) return fs.readFile(flags['input-file'], 'utf-8')
  return flags.input
}

async function main(): Promise<void> {
  const { op, pos, flags } = parse(process.argv.slice(2))

  // HELP — a bare `dqa-fos`, `--help`/`-h`, or `help` prints usage instead of
  // falling through to the required-flag check (which used to emit the cryptic
  // "missing --app"). Plain text on stdout, exit 0.
  if (op === undefined || op === '--help' || op === '-h' || op === 'help' || 'help' in flags || 'h' in flags) {
    process.stdout.write(HELP + '\n')
    return
  }

  // The TENANT namespaces a run's workflow state + ontology data. Optional:
  // defaults to 'default', so the model is just "the os runs the app". Pass
  // --tenant <id> only when you need isolated cases/periods/clients side by side.
  const tenant = flags.tenant ?? 'default'

  // AUDIT — verify + dump the case ledger. Only needs --workspace.
  if (op === 'trace') {
    if (!flags.workspace) throw new Error('missing --workspace')
    const tenantDir = path.join(flags.workspace, '.dqa', 'projects', tenant)
    const verdict = await verifyLedger(tenantDir)
    return out({ verdict, entries: await readLedger(tenantDir) })
  }

  // Everything past here is an op that operates on a concrete app + workspace
  // (reset · session · command-set). Reject an UNKNOWN op now with the usage
  // hint — otherwise the --app/--workspace check below would mislead with
  // "missing --app" for what is really a typo'd command.
  if (!MGMT_OPS.has(op) && !SESSION_OPS.has(op) && !CS_OPS.has(op)) {
    throw new Error(
      `unknown op "${op}" (session: start|done|approve|status · management: reset|new-round|release|drop-run · command-set: query|get|call|act|note · audit: trace · help: --help)`,
    )
  }

  for (const req of ['app', 'workspace'] as const) {
    if (!flags[req]) throw new Error(`missing --${req}`)
  }

  // MANAGEMENT — DESTRUCTIVE reset of a tenant's run (graph + state; ledger
  // archived). Lets a corrupted/duplicated load, or a finished period, start over.
  if (op === 'reset') {
    const session = await FieldSession.open({
      appDir: flags.app,
      workspace: flags.workspace,
      ...(flags.owner ? { owner: flags.owner } : {}),
    })
    return out(await session.reset(tenant))
  }

  // MANAGEMENT — NEW ROUND: clear the run so the next `start` begins fresh, but KEEP the graph.
  // Use before a targeted `*-change` workflow to amend over the same knowledge base.
  if (op === 'new-round') {
    const session = await FieldSession.open({
      appDir: flags.app,
      workspace: flags.workspace,
      ...(flags.owner ? { owner: flags.owner } : {}),
    })
    return out(await session.newRound(tenant, undefined, flags.workflow, flags.run))
  }

  // MANAGEMENT — NHẢ LEASE của một run bỏ dở (chạy xong thì kernel tự nhả). Không có nó thì job
  // sau trên cùng sổ phải chờ hết ttl, nên buộc phải khai trùng owner — mà trùng owner thì lease
  // hết phân biệt được hai người lái.
  if (op === 'release') {
    const session = await FieldSession.open({
      appDir: flags.app,
      workspace: flags.workspace,
      ...(flags.owner ? { owner: flags.owner } : {}),
    })
    return out(await session.release(tenant, flags.workflow, flags.run))
  }

  // MANAGEMENT — BỎ HẲN một sổ đã xong việc (giữ graph + ledger). Sổ theo JOB thì mỗi lần chạy
  // đẻ một thư mục; đây là đường dọn.
  if (op === 'drop-run') {
    if (!flags.run) throw new Error('missing --run <key> (drop-run xoá ĐÚNG một sổ, không đoán sổ nào)')
    const session = await FieldSession.open({
      appDir: flags.app,
      workspace: flags.workspace,
      ...(flags.owner ? { owner: flags.owner } : {}),
    })
    return out(await session.dropRun(tenant, flags.run))
  }

  if (SESSION_OPS.has(op ?? '')) {
    const session = await FieldSession.open({
      appDir: flags.app,
      workspace: flags.workspace,
      ...(flags.owner ? { owner: flags.owner } : {}),
    })
    let cp: unknown
    switch (op) {
      case 'start':
        cp = await session.start(tenant, await readInput(flags), flags.workflow, flags.run)
        break
      case 'done':
        cp = await session.done(tenant, pos[0], json(flags.exports), undefined, flags.workflow, flags.run)
        break
      case 'approve':
        cp = await session.approve(tenant, pos[0], undefined, flags.workflow, flags.run)
        break
      case 'status':
        return out(await session.status(tenant, flags.workflow, flags.run))
    }
    // Cùng `--run`/`--workflow` (hoặc DQA_RUN) như lệnh vừa chạy ⇒ đọc đúng sổ vừa ghi.
    return out({ ...(cp as object), exports: (await session.status(tenant, flags.workflow, flags.run)).exports })
  }

  if (CS_OPS.has(op ?? '')) {
    const cs = await CommandSet.open({
      appDir: flags.app,
      workspace: flags.workspace,
      tenant,
      ...(flags.actor ? { actor: flags.actor } : {}),
    })
    // `finally` runs before each `return` below, disposing the backend pool so the
    // one-shot CLI process exits cleanly (Neo4j/pg drivers otherwise keep it alive).
    try {
      switch (op) {
        case 'query':
          return out(await cs.query(pos[0], json(pos[1]) as never))
        case 'get':
          return out(await cs.get(pos[0]))
        case 'call':
          return out(await cs.call(pos[0], json(pos[1]) ?? {}))
        case 'act':
          return out(await cs.act(pos[0], json(pos[1]) ?? {}))
        case 'note':
          await cs.note(pos[0], pos[1])
          return out({ ok: true })
      }
    } finally {
      await cs.close()
    }
  }

  throw new Error(
    `unknown op "${op}" (session: start|done|approve|status · management: reset|new-round · command-set: query|get|call|act|note · audit: trace)`,
  )
}

main().catch((err: unknown) => {
  process.stderr.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) + '\n')
  process.exitCode = 1
})
