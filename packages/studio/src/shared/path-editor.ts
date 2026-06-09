// Pure edit-state reducer for the Ant-Map path editor (FEAT-03-02, ADR-09). No React/Electron
// import, so the monorepo vitest tests it. The renderer holds an EditState, routes node clicks
// through clickNode while in edit mode, and pins the built path via the edit-commands layer.
//
// Read-mode and edit-mode are kept strictly apart (ASR #1): in read mode a node click selects (the
// renderer handles that), in edit mode it builds the path. Switching modes always clears the
// half-built path so a stale path can never be pinned by accident.

export type EditMode = 'read' | 'edit'

export interface EditState {
  mode: EditMode
  /** The capability sequence under construction, in click order. Empty outside an active edit. */
  path: string[]
}

export const initialEditState: EditState = { mode: 'read', path: [] }

/** Flip read <-> edit. Either direction clears the path: entering edit starts fresh, leaving edit
 * discards anything not yet pinned. */
export function toggleMode(state: EditState): EditState {
  return state.mode === 'read' ? { mode: 'edit', path: [] } : { mode: 'read', path: [] }
}

/** A node click while editing. Clicking the last node again pops it (undo the last step); any other
 * node is appended. Repeats are allowed as long as the node is not the immediately preceding one, so
 * a workflow like A -> B -> A can be built. In read mode the click is a no-op here. */
export function clickNode(state: EditState, nodeId: string): EditState {
  if (state.mode !== 'edit') return state
  const last = state.path[state.path.length - 1]
  if (last === nodeId) return { ...state, path: state.path.slice(0, -1) }
  return { ...state, path: [...state.path, nodeId] }
}

/** Append a step unconditionally (no pop-on-last). Explicit add actions (search and successor buttons,
 * drag-to-connect) always mean "add this", unlike a graph node click which toggles the last step off
 * (clickNode). No-op outside edit mode. */
export function appendNode(state: EditState, nodeId: string): EditState {
  if (state.mode !== 'edit') return state
  return { ...state, path: [...state.path, nodeId] }
}

/** Drop the built path but stay in edit mode. */
export function clearPath(state: EditState): EditState {
  return { ...state, path: [] }
}

/** A path can be pinned once it has at least one capability while editing. */
export function canPin(state: EditState): boolean {
  return state.mode === 'edit' && state.path.length >= 1
}
