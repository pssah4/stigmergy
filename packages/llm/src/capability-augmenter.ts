import type { CapabilityAugmenter } from '@agentic-stigmergy/core'
import type { ApiHandler } from './types.js'

// Capability augmenter (FEAT-01-07, ADR-11). Wraps an ApiHandler.classifyText call into the
// core CapabilityAugmenter seam: builds a stable prompt, enforces a timeout, and returns the
// enriched description with the model id. Any failure (timeout, network, empty) returns null so
// the engine falls back to the raw description (SC-04). The engine calls this in
// registerCapability, never on the consult hot-path (SC-03).

export interface AugmenterOptions {
  /** Model id recorded as augmented_by (provenance). */
  model: string
  /** Abort the call after this many ms (default 5000, FEAT-01-07 NFR). */
  timeoutMs?: number
  /** Override the prompt. The default disambiguates a generic capability description. */
  promptTemplate?: (input: { id: string; type: string; description: string }) => string
}

const DEFAULT_TEMPLATE = (input: { id: string; type: string; description: string }): string =>
  'Rewrite this agent capability description so it is semantically richer and more specific for ' +
  'embedding-based retrieval. One sentence, under 40 words, no preamble.\n\n' +
  `id: ${input.id}\ntype: ${input.type}\ndescription: ${input.description}`

export function makeCapabilityAugmenter(handler: ApiHandler, opts: AugmenterOptions): CapabilityAugmenter {
  const template = opts.promptTemplate ?? DEFAULT_TEMPLATE
  const timeoutMs = opts.timeoutMs ?? 5000
  return {
    async augment(input) {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      // Absolute deadline via Promise.race: even a handler that ignores the AbortSignal cannot
      // block past timeoutMs. The abort() still cancels a cooperating fetch. classifyText errors
      // resolve to null so the race never rejects (and never leaks an unhandled rejection).
      const classified = handler
        .classifyText(template(input), controller.signal)
        .then((text) => {
          const trimmed = text.trim()
          return trimmed ? { description: trimmed, model: opts.model } : null
        })
        .catch(() => null)
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(null)
        }, timeoutMs)
      })
      try {
        return await Promise.race([classified, deadline])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
