// CLI transport — the OTHER thin adapter over the same `Kernel.emitEvent`.
// `dqa emit-event --app demo --action demo_ingestDoc --params '{"ref":"D1"}'`.
// Proves (with the HTTP server) DoD E: one core, two transports, identical
// downstream state.

import type { Kernel, IngressInput } from '../ports/transport.js'
import type { Args } from '@dqa-ai-solutions/ontology-runtime'

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name]
  if (!v) throw new Error(`emit-event: missing required --${name}`)
  return v
}

/** Parse `emit-event` argv into the kernel's ingress shape. */
export function parseEmitEventArgs(argv: string[]): IngressInput {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) flags[a.slice(2)] = argv[++i] ?? ''
  }
  return {
    tenant: flags.tenant ?? 'default',
    app: required(flags, 'app'),
    action: required(flags, 'action'),
    params: (flags.params ? JSON.parse(flags.params) : {}) as Args,
  }
}

/** Parse argv and submit to the kernel (enqueue an ingest-intent). */
export function runEmitEvent(kernel: Kernel, argv: string[]): Promise<{ intentId: string }> {
  return kernel.emitEvent(parseEmitEventArgs(argv))
}
