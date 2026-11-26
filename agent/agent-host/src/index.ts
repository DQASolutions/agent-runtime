export { FieldApp, type FieldAppOptions, type FieldAppRunOptions, type RunResult } from './field-app.js'
export { FieldSession, type SessionOptions, type Checkpoint } from './session.js'
export { CommandSet, type CommandSetOptions } from './command-set.js'
export {
  appendTrace,
  readLedger,
  verifyLedger,
  ledgerPath,
  type TraceEvent,
  type TraceInput,
  type TraceKind,
  type LedgerVerdict,
} from './trace.js'
export { writeGrant, readGrant, grantPath, type CapabilityGrant } from './grant.js'
export { loadAppExecutors, type AppExecutorIO } from '@dqa-ai-solutions/agent-steps'
// Re-export the executor contract so app executors can type themselves against
// `@dqa-ai-solutions/agent-host` (their runtime dependency) without reaching into the engine.
export type { StepExecutor, StepContext, StepResult } from '@dqa-ai-solutions/agent-orchestrator'

