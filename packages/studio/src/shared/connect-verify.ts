// Substrate-observing connect-verify for the Connect-Panel (FEAT-03-03, ASR #2). The Studio cannot
// wrap a host loop's engine (it holds a read-only view), so it detects a live loop by watching the
// substrate the loop writes to. A wired loop that completes its first task persists a task row (task
// count rises, the engine writes the row on resolution/deposit, not on a bare consult) and deposits
// pheromone (edge activity changes); green requires both, so it confirms a full task round-trip, not
// just a consult. Pure, so the monorepo vitest covers SC-03's mechanism; the green indicator itself
// is a manual end-test.
import type { SubstrateSnapshot } from './graph-model.js'

export interface ActivityProbe {
  taskCount: number
  /** Cheap fingerprint of edge activity: edge count plus summed pheromone. Moves when a deposit lands. */
  edgeActivity: number
}

export interface ConnectProgress {
  consultSeen: boolean
  eventSeen: boolean
  green: boolean
}

const EPSILON = 1e-9

export function probeActivity(snapshot: SubstrateSnapshot): ActivityProbe {
  let edgeActivity = snapshot.edges.length
  for (const e of snapshot.edges) edgeActivity += e.pheromone
  return { taskCount: snapshot.taskCount ?? 0, edgeActivity }
}

/** Compare a baseline probe (taken when "listening" started) to the current one. Green once both a
 * consult (more tasks) and an event (changed edge activity) have appeared since the baseline. */
export function compareActivity(baseline: ActivityProbe, current: ActivityProbe): ConnectProgress {
  const consultSeen = current.taskCount > baseline.taskCount
  const eventSeen = Math.abs(current.edgeActivity - baseline.edgeActivity) > EPSILON
  return { consultSeen, eventSeen, green: consultSeen && eventSeen }
}
