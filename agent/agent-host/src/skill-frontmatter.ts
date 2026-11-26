// Parse a skill's optional YAML frontmatter. A skill file is `---\n<yaml>\n---\n<body>`;
// the body is the playbook instruction, and `tools:` lists the command-set
// operations (functions/actions) the skill is allowed to call. FieldSession
// surfaces `body` + `tools` at an investigation checkpoint so the agent (Claude
// Code) knows the procedure AND which `dqa-fos` calls it may make.
//
// v1: `tools` is advisory (surfaced for the agent to honour); hard capability
// enforcement is a later rung. No frontmatter → the whole text is the body.

import yaml from 'js-yaml'

export interface ParsedSkill {
  body?: string
  /** Allowed command-set operations (function/action names). */
  tools?: string[]
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseSkill(text?: string): ParsedSkill {
  if (!text) return {}
  const m = FRONTMATTER.exec(text)
  if (!m) return { body: text.trim() || undefined }
  const fm = (yaml.load(m[1]) ?? {}) as Record<string, unknown>
  const tools = Array.isArray(fm.tools) ? fm.tools.map(String) : undefined
  const body = m[2].trim() || undefined
  return { ...(body ? { body } : {}), ...(tools ? { tools } : {}) }
}
