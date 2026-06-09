// Unix exit codes for the CLI (FEAT-01-06 SC-06, technical.md). A command throws a
// CliError with the right code; run() maps it to process.exitCode.

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  ARGS: 2,
  NOT_FOUND: 3, // substrate not found
  // Reserved forward contract: produced once the single-writer lock and schema migration land
  // (BL-008). Until then a lock conflict or schema mismatch surfaces as GENERIC (1).
  LOCK: 4, // lock conflict
  SCHEMA: 5, // schema mismatch
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode = EXIT.GENERIC,
  ) {
    super(message)
    this.name = 'CliError'
  }
}
