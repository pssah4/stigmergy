// @stigmergy/cli: the command-line interface over the library API (FEAT-01-06, ADR-07).
// run() is the pure, dependency-injected entry; bin.ts wires the concrete deps and is the
// installed `stigmergy` executable.
export * from './cli.js'
export * from './args.js'
export * from './exit-codes.js'
export * from './paths.js'
export * from './trust.js'
