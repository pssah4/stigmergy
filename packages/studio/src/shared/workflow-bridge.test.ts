import { describe, it, expect } from 'vitest'
import { toWorkflowMarkdown, parseWorkflowMarkdown, type WorkflowDoc } from './workflow-bridge.js'

const DOC: WorkflowDoc = {
  name: 'Note Summary Report',
  description: 'Reads a note, summarises it, writes the report.',
  behavior: 'sequence',
  capabilitySequence: ['tool:vector_search', 'tool:file_read', 'tool:file_write'],
}

describe('toWorkflowMarkdown (SC-01)', () => {
  it('emits YAML frontmatter with name, description, behavior and steps', () => {
    const md = toWorkflowMarkdown(DOC)
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('behavior: sequence')
    expect(md).toContain('steps:')
    expect(md).toContain('tool:vector_search')
    expect(md).toContain('# Note Summary Report')
  })
})

describe('parseWorkflowMarkdown (SC-02)', () => {
  it('reads the frontmatter back into a WorkflowDoc', () => {
    const parsed = parseWorkflowMarkdown(toWorkflowMarkdown(DOC))
    expect(parsed).toEqual(DOC)
  })

  it('returns null without a frontmatter block, a name, a behavior, or steps', () => {
    expect(parseWorkflowMarkdown('no frontmatter here')).toBeNull()
    expect(parseWorkflowMarkdown('---\ndescription: "x"\nbehavior: preferred\nsteps:\n  - "tool:a"\n---')).toBeNull()
    expect(parseWorkflowMarkdown('---\nname: "x"\nbehavior: preferred\nsteps:\n---')).toBeNull()
    expect(parseWorkflowMarkdown('---\nname: "x"\nbehavior: nonsense\nsteps:\n  - "tool:a"\n---')).toBeNull()
  })
})

describe('round-trip is lossless (SC-03)', () => {
  const cases: WorkflowDoc[] = [
    DOC,
    { name: 'Empty desc', description: '', behavior: 'preferred', capabilitySequence: ['tool:a'] },
    { name: 'Tricky: "quotes" and: colons', description: 'line, with, commas', behavior: 'enforce', capabilitySequence: ['mcp:b', 'tool:a', 'mcp:b'] },
    { name: 'With params', description: 'd', behavior: 'sequence', capabilitySequence: ['tool:a', 'tool:b'], parametersTemplate: { topic: 'x', limit: 5 } },
  ]
  it.each(cases)('parse(to(doc)) equals doc for %o', (doc) => {
    expect(parseWorkflowMarkdown(toWorkflowMarkdown(doc))).toEqual(doc)
  })

  it('preserves the parameters template (SC-03)', () => {
    const parsed = parseWorkflowMarkdown(toWorkflowMarkdown({ ...DOC, parametersTemplate: { a: 1, nested: { b: true } } }))
    expect(parsed?.parametersTemplate).toEqual({ a: 1, nested: { b: true } })
  })

  it('tolerates CRLF line endings and a UTF-8 BOM from an external writer', () => {
    const crlf = '\uFEFF' + toWorkflowMarkdown(DOC).replace(/\n/g, '\r\n')
    expect(parseWorkflowMarkdown(crlf)).toEqual(DOC)
  })
})
