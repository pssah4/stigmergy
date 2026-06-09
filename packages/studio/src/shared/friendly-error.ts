// Map a raw runtime error to an actionable message (FEAT-03-08, SC-07). The first launch hits the
// native-module ABI mismatch (better-sqlite3 built for the system Node, Electron needs its own ABI);
// the raw "NODE_MODULE_VERSION 141 ... requires 125" text leaves a newcomer stuck. This turns the
// known cases into a concrete next step. Pure, so the monorepo vitest covers it.

/** Whether the error is the native-module ABI mismatch (better-sqlite3 built for the wrong runtime).
 * The onboarding wizard (FEAT-05-05) gates its native-binding step on this. */
export function isNativeRebuildError(raw: string): boolean {
  return /NODE_MODULE_VERSION|compiled against a different Node\.js version|different Node\.js version/i.test(raw)
}

export function friendlyError(raw: string): string {
  if (isNativeRebuildError(raw)) {
    return (
      'The database module needs rebuilding for Electron. Run: npm run rebuild:electron -w @stigmergy/studio, ' +
      'then restart the app. To run the tests again afterwards: npm rebuild better-sqlite3.'
    )
  }
  if (/Substrate not found|fileMustExist|unable to open database|ENOENT|no such file/i.test(raw)) {
    return 'No memory file at this path yet. Create one with `stigmergy init`, or set the path in Settings.'
  }
  return raw
}
