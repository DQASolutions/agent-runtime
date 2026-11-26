// Capability grant — the bridge that makes the skill's `tools:` frontmatter a
// HARD constraint (Step 2). When a FieldSession hands control to an agent step,
// it writes the step's granted tools to `.dqa/projects/<tenant>/active-grant.json`.
// The command-set (the agent's only door) reads it and enforces: an Action not
// in `tools` is refused at the write door. No grant file = no governed step in
// flight → command-set runs unconstrained (standalone use); a present grant =
// the door is hard.

import path from 'node:path'
import fs from 'fs-extra'

export interface CapabilityGrant {
  /** Workflow task this grant is for. */
  task: string
  /** Allowed command-set ops (function/action names) from the skill frontmatter. */
  tools: string[]
  /** ISO 8601 issue time. */
  issuedAt: string
}

export function grantPath(tenantDir: string): string {
  return path.join(tenantDir, 'active-grant.json')
}

/** Issue (overwrite) the active grant for a tenant's current agent step. */
export async function writeGrant(tenantDir: string, grant: CapabilityGrant): Promise<void> {
  await fs.ensureDir(tenantDir)
  await fs.writeJson(grantPath(tenantDir), grant, { spaces: 2 })
}

/** Read the active grant, or null when none is in flight. */
export async function readGrant(tenantDir: string): Promise<CapabilityGrant | null> {
  return fs.readJson(grantPath(tenantDir)).catch(() => null)
}
