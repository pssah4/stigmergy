# Stigmergy

Stigmergy gives an agent loop a memory of what already worked. It watches which capabilities a loop
reaches for, learns the capability paths that lead to accepted outcomes, and surfaces a proven path the
next time a similar task comes up, so the agent stops re-exploring the same ground every run. It runs
beside your loop, never blocks it, and turns into a no-op when switched off.

## The problem

Agent loops rediscover their tools on every run. As the toolset grows (function-calling tools, skills,
MCP servers, sub-agents), the model spends turns probing what exists and how to call it, and a flat
catalog of everything bloats the prompt. The loop has no memory: a sequence of steps that solved a task
last week is gone, so the same exploration cost is paid again. Progressive disclosure (load tools on
demand) keeps the prompt small but does nothing to recall what succeeded before.

## The solution

Stigmergy is a host-external substrate, inspired by how ants lay pheromone trails. It observes the loop
and reinforces the transitions that get accepted, so it learns the paths that work for a kind of task.
When a new task clearly matches a path it has already solved successfully, it surfaces that path as a
small hint and can pre-activate exactly the tools the path needs, so the agent skips the rediscovery.
When it does not recognize the task, it stays silent and your loop's own tool selection runs unchanged.

It complements progressive disclosure, it does not replace it: your retrieval stays the precise default,
Stigmergy is the recall layer on top. It is non-blocking (a consult is an in-memory lookup under ten
milliseconds, all embedding runs in the background), it degrades to a no-op when it is off or the daemon
is unreachable, and it learns only from graded outcomes, so a flailing run is never reinforced.

## How it works

- **Register once.** The host tells the substrate which capabilities exist, across all four kinds:
  tools, skills, MCP tools, and sub-agents, each with a stable id and a short description.
- **Per turn: consult, instrument, grade.** Before the model picks a step, the loop asks the substrate
  which proven path fits the task. As tools run, the loop reports `invoked` and `returned`. When the
  turn resolves, the loop grades it: accepted, iterated, or abandoned.
- **Pheromone on a path graph.** Accepted transitions deposit pheromone, weighted by quality and token
  efficiency and decayed over time; discarded or abandoned ones accrue negative evidence. Selection is
  deterministic given a seed (multiplicative desirability plus Thompson sampling over the decayed
  evidence), so the substrate never makes the loop guess.
- **Recall, not a second selector.** On a confident match (a learned, named path whose context fits) the
  substrate returns a sequence and the host pre-activates that path's capabilities plus a one-line hint.
  Otherwise it returns a neutral result and the host's own selection decides. It never reorders or hides
  your tools.
- **Local and off the hot path.** Semantic matching uses a local embedding model; capability and query
  embeddings are computed in a background worker, so a consult is a synchronous in-memory read.

## Installation

Stigmergy is an npm-workspaces monorepo with an Electron desktop app (the Studio) and a set of
thin-client packages for wiring it into your loop.

```bash
git clone https://github.com/pssah4/stigmergy.git
cd stigmergy
npm install
npm run build
```

Run the Studio (the desktop app that owns the database and the daemon, and walks you through setup):

```bash
npm run dev -w @stigmergy/studio
```

If the native database module reports a version mismatch on first launch, rebuild it for the desktop
runtime once: `npm run rebuild:electron -w @stigmergy/studio`. The first-run wizard also points this out.

## Using it

**Start in the Studio.** On first launch a guided wizard takes you from nothing to a running setup: it
checks the native module, lets you pick a memory file, add an LLM provider (used only for naming learned
paths, the embedding is a local on-device model), start the daemon, connect your agent loop, and switch
Stigmergy on. You can re-open the wizard any time from Settings.

**Connect your loop.** The Studio's connect step gives you a copy-paste prompt for your coding agent (or
a snippet for a supported SDK) that wires three calls into your loop: consult before tool selection,
instrument tool execution, and grade the turn on resolution. Your loop holds only the thin client; the
daemon owns the model and the database.

For a supported SDK, install the matching adapter instead of hand-wiring:

| Package | Use it for |
|---|---|
| `@agentic-stigmergy/loop` | The SDK-agnostic facade: `beginTurn` / instrument / grade |
| `@agentic-stigmergy/client` | Thin client over the daemon's socket (your loop holds no engine) |
| `@agentic-stigmergy/core` | The embedded engine, if you want it in-process instead of a daemon |
| `@stigmergy/integration-vercel-ai`, `-langchain`, `-openai-agents` | Drop-in SDK adapters |

**Watch it learn.** The Studio's graph shows your capabilities as nodes and the learned paths as edges
that thicken as they are reinforced. Search and filter your saved paths, click one to highlight it in
the graph, or collapse the side panel to work in the graph alone.

## Library quickstart

If you want the engine in-process rather than the daemon, wire it directly:

```ts
import { createEngine } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { TransformersEmbedding } from '@stigmergy/embedding-transformers'

const engine = await createEngine({
  storage: await createSqlJsStorage(), // or a better-sqlite3 store for Node persistence
  embedding: new TransformersEmbedding(), // local all-MiniLM-L6-v2 on onnxruntime-node
})

await engine.registerCapability({ id: 'tool:summarize', type: 'tool', description: 'summarize long documents' })

const decision = await engine.consult({ task_id: 't1', context: 'summarize this report' })
// decision.mode: 'ranked' (neutral), or 'sequence' / 'enforce' when a path is pinned.

await engine.emit({ type: 'task_started', taskId: 't1', context: 'summarize this report' })
await engine.emit({ type: 'capability_invoked', taskId: 't1', capabilityId: 'tool:summarize' })
await engine.emit({ type: 'capability_returned', taskId: 't1', capabilityId: 'tool:summarize', success: true })
await engine.emit({ type: 'response_delivered', taskId: 't1' })
await engine.emit({ type: 'task_accepted', taskId: 't1', tokenCost: 800 }) // or task_abandoned on failure

await engine.close()
```

Over many tasks the substrate reinforces transitions that get accepted, so later consults rank
previously successful paths higher. If you already know the path and the outcome, skip the per-step
events and call `engine.deposit({ task_id, context, path, outcome, token_cost })` directly. Pin a path to
always prefer, enforce, or sequence it: `engine.pinPath({ capability_sequence, behavior })`.

## Packages

| Package | Purpose |
|---|---|
| `@agentic-stigmergy/core` | Engine, scoring and decay, outcome tracker, background embedder, ports |
| `@agentic-stigmergy/loop` | SDK-agnostic loop facade (beginTurn / instrument / grade), degrade-safe |
| `@agentic-stigmergy/client` | Thin client over the daemon's Unix socket |
| `@stigmergy/storage-better-sqlite3` | Node storage adapter (WAL, native) |
| `@stigmergy/storage-sqljs` | Sandbox storage adapter (WASM, in-memory) |
| `@stigmergy/embedding-transformers` | Local embedding adapter (all-MiniLM-L6-v2 on onnxruntime-node) |

## Development

```bash
npm run build       # tsc -b across the workspace
npm test            # vitest (offline, deterministic)
```

The embedding adapter is verified against the real model behind an env flag, so the default suite stays
offline: `STIGMERGY_EMBEDDING_IT=1 npm test` downloads the model on first run.

## License

Apache-2.0
