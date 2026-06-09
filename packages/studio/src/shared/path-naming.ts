// Path naming (FEAT-03-07, ADR-11). Proposes a human-readable name for a pinned path. When a
// provider is configured (the same ported provider layer as FEAT-01-07), it asks the LLM via
// classifyText (SC-03); otherwise, or on any failure, it falls back to a deterministic id-name
// Path-XXXX-YYYY (SC-04). No React/Electron import, so the monorepo vitest covers it with a fake
// handler. The emergent naming queue and worker (SC-02) are deferred.
import type { ApiHandler } from '@stigmergy/llm'

export interface ProposedName {
  name: string
  description: string
  namedBy: 'llm' | 'fallback'
}

export function buildNamingPrompt(sequence: string[]): string {
  return [
    'Name this capability workflow with a short human-readable label and a one-sentence description.',
    'Respond with JSON only: {"name": "...", "description": "..."}',
    `Capabilities in order: ${sequence.join(' -> ')}`,
  ].join('\n')
}

/** Parse the LLM JSON answer. Tolerates surrounding prose or code fences by extracting the first
 * {...} block. Returns null when there is no usable name. */
export function parseNamingResponse(raw: string): { name: string; description: string } | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(match[0])
    if (parsed === null || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    if (name.length === 0) return null
    return { name, description: typeof obj.description === 'string' ? obj.description.trim() : '' }
  } catch {
    return null
  }
}

/** Deterministic id-name from the sequence (no LLM, no clock, no randomness): FNV-1a 32-bit hash
 * rendered as Path-XXXX-YYYY. Same sequence always yields the same name (SC-04). */
export function fallbackName(sequence: string[]): string {
  let hash = 0x811c9dc5
  const text = sequence.join('>')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0').toUpperCase()
  return `Path-${hex.slice(0, 4)}-${hex.slice(4, 8)}`
}

/** Propose a name for a path. Uses the handler when present and it returns parseable JSON; otherwise
 * falls back to the deterministic id-name. Never throws (a provider failure becomes the fallback). */
export async function proposePathName(handler: ApiHandler | null, sequence: string[], signal?: AbortSignal): Promise<ProposedName> {
  const fallback: ProposedName = { name: fallbackName(sequence), description: '', namedBy: 'fallback' }
  if (!handler) return fallback
  try {
    const raw = await handler.classifyText(buildNamingPrompt(sequence), signal)
    const parsed = parseNamingResponse(raw)
    return parsed ? { name: parsed.name, description: parsed.description, namedBy: 'llm' } : fallback
  } catch {
    return fallback
  }
}
