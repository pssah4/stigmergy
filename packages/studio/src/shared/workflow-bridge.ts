// Portable workflow format (FEAT-03-06/FEAT-03-08). A pinned path is a portable workflow; this is
// the generic, lossless serialization (SC-03): toWorkflowMarkdown
// writes a YAML-frontmatter workflow file, parseWorkflowMarkdown reads it back. We control both ends,
// so scalars are JSON-quoted (a JSON string is a valid YAML double-quoted scalar) which keeps quotes,
// colons and commas round-trip-safe without a YAML dependency. No React/Electron import, so the
// monorepo vitest covers it.
import type { PinBehavior } from '@agentic-stigmergy/core'

export interface WorkflowDoc {
  name: string
  description: string
  behavior: PinBehavior
  capabilitySequence: string[]
  /** Optional parameter template; carried so a promote/inject round-trip is lossless (SC-03). */
  parametersTemplate?: Record<string, unknown>
}

const PIN_BEHAVIORS: readonly PinBehavior[] = ['preferred', 'enforce', 'sequence']

export function toWorkflowMarkdown(doc: WorkflowDoc): string {
  const frontmatter = [
    '---',
    `name: ${JSON.stringify(doc.name)}`,
    `description: ${JSON.stringify(doc.description)}`,
    `behavior: ${doc.behavior}`,
  ]
  if (doc.parametersTemplate !== undefined) {
    frontmatter.push(`parametersTemplate: ${JSON.stringify(doc.parametersTemplate)}`)
  }
  frontmatter.push('steps:', ...doc.capabilitySequence.map((step) => `  - ${JSON.stringify(step)}`), '---')
  return [...frontmatter, '', `# ${doc.name}`, '', doc.description, ''].join('\n')
}

/** Read a JSON-quoted scalar for `key:` from the frontmatter block, or null if absent/invalid. */
function readScalar(block: string, key: string): string | null {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (!match) return null
  try {
    const value: unknown = JSON.parse(match[1]!)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

export function parseWorkflowMarkdown(md: string): WorkflowDoc | null {
  // Tolerate a UTF-8 BOM and CRLF line endings from an external (e.g. Windows) writer.
  const text = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatter) return null
  const block = frontmatter[1]!

  const name = readScalar(block, 'name')
  const behavior = block.match(/^behavior:\s*(\w+)/m)?.[1]
  const steps: string[] = []
  for (const line of [...block.matchAll(/^\s*-\s*(.+)$/gm)]) {
    try {
      const value: unknown = JSON.parse(line[1]!)
      if (typeof value === 'string') steps.push(value)
    } catch {
      // skip an unparseable step line
    }
  }

  if (!name || !behavior || !PIN_BEHAVIORS.includes(behavior as PinBehavior) || steps.length === 0) return null
  const doc: WorkflowDoc = {
    name,
    description: readScalar(block, 'description') ?? '',
    behavior: behavior as PinBehavior,
    capabilitySequence: steps,
  }
  const templateLine = block.match(/^parametersTemplate:\s*(.+)$/m)
  if (templateLine) {
    try {
      const parsed: unknown = JSON.parse(templateLine[1]!)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc.parametersTemplate = parsed as Record<string, unknown>
      }
    } catch {
      // ignore an unparseable parametersTemplate; the rest of the workflow still imports
    }
  }
  return doc
}
