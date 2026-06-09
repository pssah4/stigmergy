# @stigmergy/studio

Stigmergy Studio is the desktop app for the pheromone substrate: a window onto what your agent loops
have learned, plus tools to shape it. Stigmergy learns which tools an agent loop reaches for by
watching it run; the Studio shows that as a map of tools and paths, lets you save paths, and guides
you through connecting a loop.

It is general-purpose. A saved path is a portable workflow; named integrations (Vault Operator is
one optional example) are plugins, not baked into the UI.

## Stack (ADR-15)

- Electron main process plus a React renderer, built with `electron-vite` and Vite.
- Graph rendering via `sigma` plus `graphology` (`@react-sigma/core`).
- Substrate access is embedded: the main process opens the SQLite file `better-sqlite3` read-only
  over WAL (a loop can keep writing while the app reads), polls every 2 seconds, and pushes a
  snapshot to the renderer over IPC. Writes go through an on-demand read-write engine.

This package is its own buildable and is not part of the library `tsc -b`.

## Run

```bash
# from the repo root
npm install
npx tsc -b                                  # build the library packages the studio imports
npm run rebuild:electron -w @stigmergy/studio   # rebuild better-sqlite3 for Electron's ABI (first run)
npm run dev -w @stigmergy/studio            # electron-vite dev plus an Electron window
```

`rebuild:electron` is needed because the native `better-sqlite3` is built for your system Node by
default, but Electron ships its own Node ABI (the first launch otherwise shows a
`NODE_MODULE_VERSION` error; the app now surfaces that with the exact command to run). To run the
monorepo tests again afterwards, rebuild for system Node: `npm rebuild better-sqlite3`.

Without anything else the app opens the default substrate at `~/.stigmergy/pheromone.db` (create it
first with `stigmergy init`). Point it at another substrate in dev with the `STIGMERGY_SUBSTRATE` env
var (the `--substrate` flag only works in the packaged app):

```bash
STIGMERGY_SUBSTRATE=/path/to/pheromone.db npm run dev -w @stigmergy/studio
```

## First run

A fresh substrate is empty, so the map shows a welcome card, not a blank canvas. It explains the
model (Stigmergy watches your loop and learns; it does not fill itself), and offers a guided
"Connect your agent loop" wizard: pick your loop's project folder, detect the framework, insert the
snippet (a developer wires the loop once, the one manual step), then run the loop once and watch the
connection turn green.

## Layout (n8n-oriented)

A left rail selects the right-hand panel; the centre is the capability map; the header carries the
editor toggle and live counts.

- **Graph**: the map plus the inspector. Click a tool or path to see details; in build mode (editor
  toggle) click tools in order to build and save a path.
- **Connect loop**: the connect wizard plus optional integrations.
- **History**: past runs (the executions view).
- **Memory**: numbers, backup/restore, workflow export/import, and a DELETE-gated reset.
- **Settings**: substrate path, workflow folder, and behaviour parameters.

## Plain language

User-facing labels lead with plain English; the technical term lives in a tooltip. The mapping is one
source (`src/shared/labels.ts`): Substrate -> Memory, Capability -> Tool, pinned -> Saved, Edit mode
-> Editor; Pheromone is kept (the ant-trail metaphor). Adjust the wording in one place.

## Layout of the source

| Path | Role |
|---|---|
| `src/shared/graph-model.ts` | Pure substrate-to-graph mapping. Unit-tested. |
| `src/shared/snapshot-mapping.ts` | Read-only SQL to view mapping (capabilities, edges, pinned paths, tasks). Integration-tested. |
| `src/shared/path-editor.ts` | Pure build-mode reducer. Unit-tested. |
| `src/shared/edit-commands.ts` | Engine dispatcher for pin/unpin/reinforce/weaken. Integration-tested. |
| `src/shared/connect-verify.ts` | Substrate-activity detector for the connect wizard. Unit-tested. |
| `src/shared/connect-wizard.ts` | Pure 4-step wizard reducer. Unit-tested. |
| `src/shared/connect-adapter.ts` | Adapter-file builder. Unit-tested. |
| `src/shared/workflow-bridge.ts` | Portable workflow markdown (lossless round-trip). Unit-tested. |
| `src/shared/integrations.ts` | Optional integration registry (Vault Operator is one entry). Unit-tested. |
| `src/shared/substrate-ops.ts` | Stats and the reset gate. Unit-tested. |
| `src/shared/settings.ts` | Settings defaults and validation. Unit-tested. |
| `src/shared/path-naming.ts` | LLM name proposal plus fallback. Unit-tested. |
| `src/shared/substrate-path.ts` | Substrate path resolution (flag/env/default). Unit-tested. |
| `src/shared/labels.ts` | Single source of plain-language labels. Unit-tested. |
| `src/shared/friendly-error.ts` | Maps raw errors to actionable hints. Unit-tested. |
| `src/main/index.ts` | Electron main: read poll, IPC, write engine, dialogs. |
| `src/preload/index.ts` | contextBridge exposing `window.studio`. |
| `src/renderer/` | React app: `App`, `LeftRail`, `AntMap`, `DetailPanel`, `EditPanel`, `ConnectWizard`, `Welcome`, `OperationsPanel`, `SettingsPanel`. |

## What is tested vs. manual

The value-bearing logic in `src/shared` is unit- and integration-tested in the monorepo vitest
(graph mapping, edit commands against a real engine, connect-verify, the wizard reducer, workflow
round-trip, settings, labels). The Electron, preload and React layer is typechecked and built; the
visual flow (the map, the wizard, the panels, 60fps) is a manual end-test.
