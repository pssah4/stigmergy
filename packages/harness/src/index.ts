// @stigmergy/harness: measurement and ablation harness for the engine (FEAT-02-03,
// ADR-08 workload versioning, ADR-13 ablation axes). Drives versioned workloads
// against a fresh engine plus an injected agent, deterministic given a seed plus a
// FixedClock, and writes JSON/Markdown reports anchored by workload hash, config
// and seed. Storage, embedding and agent are injected; this package depends only
// on @agentic-stigmergy/core types.
export * from './workload.js'
export * from './ablation.js'
export * from './agent.js'
export * from './runner.js'
export * from './metrics.js'
export * from './report.js'
export * from './sweep.js'
export * from './diff.js'
export * from './runconfig.js'
export * from './cli.js'
