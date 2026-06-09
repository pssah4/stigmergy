#!/usr/bin/env node
// stigmergyd executable (FEAT-04-04). The Studio spawns this and manages its lifecycle (no terminal
// use by the operator). Reads the substrate path from argv[2] or STIGMERGY_SUBSTRATE, and an optional
// consult socket from STIGMERGY_DAEMON_SOCKET. Exits 4 if another daemon already owns the substrate.
import { startDaemon } from './run.js'

async function main(): Promise<void> {
  const substratePath = process.argv[2] ?? process.env['STIGMERGY_SUBSTRATE'] ?? ''
  if (!substratePath) {
    process.stderr.write('stigmergyd: substrate path required (argv[2] or STIGMERGY_SUBSTRATE)\n')
    process.exit(2)
  }
  const socketPath = process.env['STIGMERGY_DAEMON_SOCKET'] || undefined
  const handle = await startDaemon({ substratePath, socketPath })
  if (!handle) {
    process.stderr.write('stigmergyd: another daemon already owns this substrate\n')
    process.exit(4)
  }
  process.stdout.write(`stigmergyd: serving ${substratePath}${socketPath ? ` (consult on ${socketPath})` : ''}\n`)
  const shutdown = (): void => void handle.stop().then(() => process.exit(0))
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main().catch((e: unknown) => {
  process.stderr.write(`stigmergyd: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
