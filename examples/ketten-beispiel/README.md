# Ketten-Beispiel

The whole Stigmergy chain in one runnable script: a tiny agent loop registers a toolset, turns
Stigmergy on, runs a few tasks through the loop facade, and the substrate fills with edges,
pheromone and tasks. Open Stigmergy Studio on the same substrate to watch the graph light up.

## Run

```bash
node examples/ketten-beispiel/run.mjs /tmp/stigmergy-demo.db
```

Offline by default: `FakeEmbedding`, no LLM, no network. It uses the built workspace packages, so
build first (`npm run build` at the repo root, or `tsc -b`).

Expected output (numbers vary):

```
Substrate: /tmp/stigmergy-demo.db
  tools=4  edges=6  tasks=3  avgPheromone=0.567
  surfaced for "read and summarize a file": tool:read_file, tool:summarize, tool:search

Done. Open Stigmergy Studio on this substrate to see the learned graph.
```

## What it shows

- The loop ships wired but **disabled** by default (FEAT-04-06); the script turns it on, mirroring the
  Studio's on/off toggle. While disabled the loop records nothing.
- Each turn goes through `StigmergyLoop.beginTurn -> instrument -> end -> accept`; an accepted task
  reinforces its trail, so repeating "read and summarize" raises those tools above the rest.
- The substrate is a plain SQLite file. Point Stigmergy Studio at it (Settings -> memory file location)
  to see the capability map, paths and history.

## Studio + daemon

To see semantic surfacing and auto-named paths, configure a model in the Studio (Settings) and start
the daemon from the Studio (Settings -> Start daemon). The daemon embeds, names emergent paths, and
serves consult; the loop connects as a client (`@agentic-stigmergy/client`) and falls back to local when the
daemon is down. No terminal needed.
