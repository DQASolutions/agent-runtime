/**
 * Remote content port.
 *
 * The runtime reads workflows and task instructions from local files. A remote
 * content server is an OPTIONAL source that a host plugs in at start-up with
 * `setRemoteContentSource()`.
 *
 * With no source registered, remote mode is off and every caller falls back to
 * local loading (see schema-engine.loadWorkflow, resolve-task-instruction).
 *
 * A source may implement more than this interface; other packages reach the
 * registered source with `getRemoteContentSource()`.
 */

/** What a remote content source must provide. Implemented outside the runtime. */
export interface RemoteContentSource {
  /** True when the source is configured (server URL + signing key available). */
  isEnabled(): boolean
  /** A workflow document, parsed (equivalent to `yaml.load(file)`). */
  fetchWorkflow(name: string): Promise<Record<string, unknown>>
  /** A rendered task instruction. */
  fetchTaskInstruction(
    workflowId: string,
    taskId: string,
    contextRefs?: Record<string, string>,
  ): Promise<string>
  /** Optional: drop cached clients (tests, env changes). */
  reset?(): void
}

let source: RemoteContentSource | undefined

/** Plug in (or, with no argument, remove) the remote content source. */
export function setRemoteContentSource(s?: RemoteContentSource): void {
  source = s
}

/** The registered source, if any. */
export function getRemoteContentSource(): RemoteContentSource | undefined {
  return source
}

function requireSource(): RemoteContentSource {
  if (!source) {
    throw new Error('Remote content mode requested but no remote content source is registered')
  }
  return source
}

/**
 * Is remote content mode enabled?
 *
 * Off when `DQA_CONTENT_MODE=off` (tests) or when no source is registered;
 * otherwise the registered source decides.
 */
export function isRemoteContentMode(): boolean {
  if (process.env.DQA_CONTENT_MODE === 'off') return false
  if (!source) return false
  try {
    return source.isEnabled()
  } catch {
    return false
  }
}

/** Fetch a workflow from the remote source. Throws so callers can fall back. */
export async function fetchWorkflowContent(name: string): Promise<Record<string, unknown>> {
  return requireSource().fetchWorkflow(name)
}

/** Fetch a rendered task instruction. Throws so callers can fall back. */
export async function fetchTaskInstruction(
  workflowId: string,
  taskId: string,
  contextRefs?: Record<string, string>,
): Promise<string> {
  return requireSource().fetchTaskInstruction(workflowId, taskId, contextRefs)
}

/** Test helper — clear the registered source's cached client. */
export function _resetContentServerClient(): void {
  source?.reset?.()
}
