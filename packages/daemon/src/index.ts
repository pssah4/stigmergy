// @stigmergy/daemon: the Studio-managed worker (ADR-19, ADR-20, FEAT-04-04). It holds the single-writer
// role lock, auto-names emergent paths, and (FEAT-04-08) hosts the consult server. This entry currently
// exports the role lock; the worker, consult server, and process lifecycle land in later increments.
export { acquireRoleLock, type RoleLock, type RoleLockOptions, type LockRecord } from './role-lock.js'
export { selectEmergentCandidates, sequenceKey, type EmergentEdge, type EmergentOptions } from './emergent.js'
export { nameEmergentPaths, type EmergentNamer, type NameEmergentResult } from './controller.js'
export { startDaemon, runOneTick, buildLlmNamer, type DaemonConfig, type DaemonHandle, type DaemonDeps, type TickDeps } from './run.js'
