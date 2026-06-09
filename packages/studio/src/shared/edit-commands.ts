// Edit commands for the path editor (FEAT-03-02, ADR-09). A small discriminated union over the
// substrate mutations the Studio offers, plus a pure validator and an engine dispatcher. No React
// or Electron import: the Electron main process calls applyEditCommand against an on-demand
// read-write engine, and the monorepo vitest exercises the same dispatcher against a real
// better-sqlite3 engine (SC-03/04/05).
//
// unpin maps to deletePath: it drops the pinned-path record, re-derives shared edges from the surviving
// pins, and PURGES any phantom edge that this pin alone created (no covering pin, no run history), so a
// hand-built path leaves no full-strength gray ghost. Edges with run history or another pin survive.

import { START_NODE, type StigmergyEngine, type PinBehavior, type PinnedPath } from '@agentic-stigmergy/core'

const PIN_BEHAVIORS: readonly PinBehavior[] = ['preferred', 'enforce', 'sequence']

export type EditCommand =
  | { kind: 'pin'; name?: string; behavior: PinBehavior; capabilitySequence: string[]; parametersTemplate?: Record<string, unknown> }
  | { kind: 'unpin'; pathId: string }
  | { kind: 'reinforce'; path: string[]; strength: number }
  | { kind: 'weaken'; path: string[]; strength: number }
  | { kind: 'deleteEdge'; from: string; to: string }

/** Validate a command before it touches the substrate. Returns an error message, or null if valid. */
export function validateEditCommand(command: EditCommand): string | null {
  switch (command.kind) {
    case 'pin':
      if (command.capabilitySequence.length < 1) return 'A pinned path needs at least one capability.'
      if (command.capabilitySequence.some((id) => id.trim() === '')) return 'A path step cannot be empty.'
      if (command.capabilitySequence.includes(START_NODE)) return 'A path step cannot be the start node.'
      if (!PIN_BEHAVIORS.includes(command.behavior)) return `Unknown pin behavior: ${command.behavior}.`
      return null
    case 'unpin':
      if (command.pathId.trim() === '') return 'unpin needs a path id.'
      return null
    case 'reinforce':
    case 'weaken':
      if (command.path.length < 1) return `${command.kind} needs a non-empty path.`
      if (!(command.strength > 0)) return `${command.kind} needs a strength greater than zero.`
      return null
    case 'deleteEdge':
      if (command.from.trim() === '' || command.to.trim() === '') return 'deleteEdge needs a from and a to endpoint.'
      if (command.from === command.to) return 'deleteEdge endpoints cannot be the same node.'
      return null
  }
}

/**
 * Apply an edit command against the engine. Validates first and throws on an invalid command, so
 * the IPC layer surfaces a clean message rather than a deep engine error. Returns the new
 * PinnedPath for a pin, undefined otherwise.
 */
export async function applyEditCommand(engine: StigmergyEngine, command: EditCommand): Promise<PinnedPath | undefined> {
  const error = validateEditCommand(command)
  if (error) throw new Error(error)
  switch (command.kind) {
    case 'pin':
      return engine.pinPath({
        name: command.name,
        behavior: command.behavior,
        capability_sequence: command.capabilitySequence,
        parameters_template: command.parametersTemplate,
      })
    case 'unpin':
      await engine.deletePath(command.pathId)
      return undefined
    case 'reinforce':
      await engine.reinforcePath({ path: command.path, strength: command.strength })
      return undefined
    case 'weaken':
      await engine.weakenPath({ path: command.path, strength: command.strength })
      return undefined
    case 'deleteEdge':
      await engine.deleteEdge(command.from, command.to)
      return undefined
  }
}
