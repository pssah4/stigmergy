// Daemon naming tick (ADR-19, FEAT-04-04). One pass: read the substrate, find emergent candidate
// paths (emergent.ts), name each via the injected namer (LLM-backed in the daemon, FEAT-04-07), and
// pin it as an emergent 'preferred' path with its name, whenToUse and the model id. The namer returns
// null when no provider is configured, so the path is skipped and stays a candidate for a later tick
// (degrade safely, no half-write). Testable with a real engine and a fake namer; no process or socket.
import type { StigmergyEngine } from '@agentic-stigmergy/core'
import { selectEmergentCandidates, sequenceKey, type EmergentOptions } from './emergent.js'

/** Produce a name plus a "when to use" for an emergent sequence, or null when no provider is configured. */
export type EmergentNamer = (sequence: string[]) => Promise<{ name: string; whenToUse: string } | null>

export interface NameEmergentResult {
  named: number
  skipped: number
}

export async function nameEmergentPaths(
  engine: Pick<StigmergyEngine, 'backup' | 'pinPath'>,
  namer: EmergentNamer,
  opts: EmergentOptions & { namedBy: string },
): Promise<NameEmergentResult> {
  const dump = await engine.backup()
  const alreadyNamed = new Set(dump.pinnedPaths.map((p) => sequenceKey(p.capabilitySequence)))
  const candidates = selectEmergentCandidates(
    dump.edges.map((e) => ({
      fromCapability: e.fromCapability,
      toCapability: e.toCapability,
      successCount: e.successCount,
      pinned: e.pinned,
    })),
    { threshold: opts.threshold, maxLen: opts.maxLen, alreadyNamed },
  )

  let named = 0
  let skipped = 0
  for (const sequence of candidates) {
    const result = await namer(sequence)
    if (!result) {
      skipped++ // no provider or naming failed: leave it for a later tick (no half-write)
      continue
    }
    await engine.pinPath({
      // 'sequence' (not 'preferred') so the LLM-produced whenToUse actually gates the path in consult
      // (ADR-18: the gate fires for sequence pins). The gate keeps it conservative: the discovered
      // trail only guides the loop when the task context matches its learned whenToUse (FEAT-04-09).
      capability_sequence: sequence,
      behavior: 'sequence',
      name: result.name,
      when_to_use: result.whenToUse,
      path_source: 'emergent',
      named_by: opts.namedBy,
    })
    named++
  }
  return { named, skipped }
}
