// Ketten-Beispiel (FEAT-04-05): the whole chain in ~40 lines. A tiny agent loop registers a toolset,
// turns Stigmergy on, runs a few tasks through the loop facade, and the substrate fills with edges,
// pheromone and tasks. Open Stigmergy Studio on the same substrate to watch it light up.
//
// Run:  node examples/ketten-beispiel/run.mjs [/path/to/pheromone.db]
// Offline by default (FakeEmbedding, no LLM, no network). Uses the built workspace packages.
import { createEngine, FakeEmbedding } from '@stigmergy/core'
import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'
import { StigmergyLoop } from '@stigmergy/loop'

const path = process.argv[2] ?? '/tmp/stigmergy-demo.db'

const storage = new BetterSqlite3Storage(path)
const engine = await createEngine({ storage, embedding: new FakeEmbedding() })

// The loop ships wired but disabled (FEAT-04-06); the operator turns it on. Here we turn it on so the
// demo records something (in the real product this is the Studio's on/off toggle).
await engine.setRuntimeFlag('enabled', '1')

const tools = [
  { id: 'tool:read_file', description: 'read a file from disk' },
  { id: 'tool:summarize', description: 'summarize text' },
  { id: 'tool:write_note', description: 'write a note to the vault' },
  { id: 'tool:search', description: 'search the web' },
]
for (const t of tools) await engine.registerCapability({ id: t.id, type: 'tool', description: t.description })

const loop = new StigmergyLoop(engine)
const candidateIds = tools.map((t) => t.id)

// A few turns: "read+summarize" twice (reinforced) and "search+write" once.
const turns = [
  { context: 'read and summarize a file', used: ['tool:read_file', 'tool:summarize'] },
  { context: 'read and summarize a file', used: ['tool:read_file', 'tool:summarize'] },
  { context: 'search the web and write a note', used: ['tool:search', 'tool:write_note'] },
]
let n = 0
for (const turn of turns) {
  const handle = await loop.beginTurn({ task_id: `task-${n++}`, prompt: turn.context, candidate_ids: candidateIds })
  const instrumented = handle.instrument(turn.used.map((id) => ({ id, run: async () => 'ok' })))
  for (const tool of instrumented) await tool.run()
  await handle.end()
  await handle.accept(500)
}

const stats = await engine.stats()
console.log(`\nSubstrate: ${path}`)
console.log(`  tools=${stats.capabilities}  edges=${stats.edges}  tasks=${stats.tasks}  avgPheromone=${stats.avgPheromone.toFixed(3)}`)

const decision = await engine.consult({ task_id: 'probe', context: 'read and summarize a file' })
if (decision.mode === 'ranked') {
  console.log('  surfaced for "read and summarize a file":', decision.ranked.slice(0, 3).map((r) => r.capabilityId).join(', '))
}
await engine.close()
console.log('\nDone. Open Stigmergy Studio on this substrate to see the learned graph.')
