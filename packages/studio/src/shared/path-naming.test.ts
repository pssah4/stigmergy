import { describe, it, expect } from 'vitest'
import { FakeApiHandler, type ApiHandler } from '@stigmergy/llm'
import { buildNamingPrompt, parseNamingResponse, fallbackName, proposePathName } from './path-naming.js'

const SEQ = ['tool:vector_search', 'tool:file_read', 'tool:file_write']

/** A stub that returns a fixed classifyText response (the FakeApiHandler echoes the prompt instead). */
function stub(response: string): ApiHandler {
  return { classifyText: async () => response }
}

describe('buildNamingPrompt', () => {
  it('asks for JSON and lists the capability sequence', () => {
    const prompt = buildNamingPrompt(SEQ)
    expect(prompt).toMatch(/json/i)
    expect(prompt).toContain('tool:vector_search -> tool:file_read -> tool:file_write')
  })
})

describe('parseNamingResponse', () => {
  it('parses a clean JSON name and description', () => {
    expect(parseNamingResponse('{"name":"Note Report","description":"Reads and writes a note."}')).toEqual({
      name: 'Note Report',
      description: 'Reads and writes a note.',
    })
  })
  it('tolerates surrounding prose or code fences', () => {
    const raw = 'Sure!\n```json\n{"name":"Daily Summary","description":"x"}\n```'
    expect(parseNamingResponse(raw)?.name).toBe('Daily Summary')
  })
  it('returns null on garbage or a missing name', () => {
    expect(parseNamingResponse('not json at all')).toBeNull()
    expect(parseNamingResponse('{"description":"no name"}')).toBeNull()
    expect(parseNamingResponse('{"name":"   "}')).toBeNull()
  })
})

describe('fallbackName (SC-04)', () => {
  it('is deterministic and matches the Path-XXXX-YYYY shape', () => {
    const a = fallbackName(SEQ)
    const b = fallbackName(SEQ)
    expect(a).toBe(b)
    expect(a).toMatch(/^Path-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })
  it('differs for a different sequence', () => {
    expect(fallbackName(SEQ)).not.toBe(fallbackName([...SEQ].reverse()))
  })
})

describe('proposePathName', () => {
  it('falls back to an id-name when no provider is configured (SC-04)', async () => {
    const result = await proposePathName(null, SEQ)
    expect(result.namedBy).toBe('fallback')
    expect(result.name).toMatch(/^Path-/)
  })

  it('uses the LLM name when the provider returns valid JSON (SC-03)', async () => {
    const result = await proposePathName(stub('{"name":"Note Report","description":"d"}'), SEQ)
    expect(result).toEqual({ name: 'Note Report', description: 'd', namedBy: 'llm' })
  })

  it('falls back when the provider returns unparseable text', async () => {
    const result = await proposePathName(new FakeApiHandler(), SEQ)
    expect(result.namedBy).toBe('fallback')
  })

  it('falls back when the provider throws', async () => {
    const throwing: ApiHandler = {
      classifyText: async () => {
        throw new Error('provider down')
      },
    }
    expect((await proposePathName(throwing, SEQ)).namedBy).toBe('fallback')
  })
})
