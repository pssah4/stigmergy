import { describe, it, expect } from 'vitest'
import { initialEditState, toggleMode, clickNode, clearPath, canPin, appendNode } from './path-editor.js'

describe('path-editor reducer', () => {
  it('starts in read mode with an empty path', () => {
    expect(initialEditState).toEqual({ mode: 'read', path: [] })
  })

  it('toggles between read and edit, clearing the path on every switch (SC-01)', () => {
    const edit = toggleMode(initialEditState)
    expect(edit.mode).toBe('edit')
    const built = clickNode(edit, 'tool:a')
    const back = toggleMode(built)
    expect(back).toEqual({ mode: 'read', path: [] }) // leaving edit clears the half-built path
  })

  it('ignores node clicks in read mode (selection is handled elsewhere)', () => {
    expect(clickNode(initialEditState, 'tool:a')).toEqual(initialEditState)
  })

  it('builds the path by sequential clicks in edit mode (SC-02)', () => {
    let s = toggleMode(initialEditState)
    s = clickNode(s, 'tool:a')
    s = clickNode(s, 'mcp:b')
    s = clickNode(s, 'skill:c')
    expect(s.path).toEqual(['tool:a', 'mcp:b', 'skill:c'])
  })

  it('toggles off the last node when it is clicked again (undo last step)', () => {
    let s = toggleMode(initialEditState)
    s = clickNode(s, 'tool:a')
    s = clickNode(s, 'mcp:b')
    s = clickNode(s, 'mcp:b')
    expect(s.path).toEqual(['tool:a'])
  })

  it('allows a capability to repeat when it is not the immediately preceding node', () => {
    let s = toggleMode(initialEditState)
    s = clickNode(s, 'tool:a')
    s = clickNode(s, 'mcp:b')
    s = clickNode(s, 'tool:a')
    expect(s.path).toEqual(['tool:a', 'mcp:b', 'tool:a'])
  })

  it('clears the path without leaving edit mode', () => {
    let s = toggleMode(initialEditState)
    s = clickNode(s, 'tool:a')
    s = clearPath(s)
    expect(s).toEqual({ mode: 'edit', path: [] })
  })

  it('canPin only once a non-empty path exists in edit mode', () => {
    expect(canPin(initialEditState)).toBe(false)
    const empty = toggleMode(initialEditState)
    expect(canPin(empty)).toBe(false)
    expect(canPin(clickNode(empty, 'tool:a'))).toBe(true)
  })
})

describe('appendNode (FEAT-06-06)', () => {
  it('appends even when the id equals the last step (no pop, unlike a graph click)', () => {
    let s = toggleMode(initialEditState)
    s = appendNode(s, 'tool:a')
    s = appendNode(s, 'tool:a')
    expect(s.path).toEqual(['tool:a', 'tool:a'])
  })

  it('is a no-op in read mode', () => {
    expect(appendNode(initialEditState, 'tool:a')).toEqual(initialEditState)
  })
})
