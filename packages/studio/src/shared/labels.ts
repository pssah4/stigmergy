// Single source of user-facing labels (FEAT-03-08, ADR-16). Plain English leads; the technical
// term lives only as a tooltip. One place, so wording stays consistent and a later localisation has
// a single seam. The Studio UI is public-facing, so it is English (project convention). No
// React/Electron import, so the monorepo vitest covers it.

export interface UiLabel {
  /** Plain-language label shown in the UI. */
  label: string
  /** Optional technical term / one-line explanation, surfaced as a tooltip (title attribute). */
  tooltip?: string
}

const RAW_LABELS = {
  // Navigation (left rail / views)
  navGraph: { label: 'Graph', tooltip: 'The learned tools and connections, as a map' },
  navConnect: { label: 'Connect loop', tooltip: 'Wire up your agent loop' },
  navPalette: { label: 'Add tools', tooltip: 'Discover available tools, MCP and skills, and compose a path' },
  navSubstrate: { label: 'Memory', tooltip: 'Substrate: the learned patterns, a local SQLite file' },
  navSettings: { label: 'Settings' },

  // Map / capabilities / paths
  capabilities: { label: 'Tools', tooltip: 'Capabilities: actions the loop can use' },
  paths: { label: 'Learned steps', tooltip: 'Learned connections between tools (one edge is one step); thicker = used more often. Distinct from Saved paths, which you pin deliberately.' },
  capability: { label: 'Tool', tooltip: 'Capability' },
  pathStrength: { label: 'Pheromone', tooltip: 'How strongly this path is learned (ant-trail metaphor)' },
  pinned: { label: 'Saved', tooltip: 'Pinned: a deliberately fixed path' },
  selectHint: { label: 'Select a tool or a connection to see details.' },

  // Build (edit) mode
  editModeOn: { label: 'Editor: on', tooltip: 'Edit mode: build a path by clicking' },
  editModeOff: { label: 'Editor: off', tooltip: 'Edit mode' },
  buildPath: { label: 'Build a path' },
  buildPathHint: { label: 'Search and add a step, pick a suggested next step, or drag node to node in the graph. Click the last node again to undo it.' },
  suggestName: { label: 'Suggest a name' },
  save: { label: 'Save path', tooltip: 'Pin: fix this path' },
  clear: { label: 'Clear' },

  // Pin behaviours (ADR-09)
  behaviorLabel: { label: 'Mode' },
  behaviorPreferred: { label: 'Preferred', tooltip: 'preferred: ranked first, the model may still pick others' },
  behaviorEnforce: { label: 'Enforced', tooltip: 'enforce: the model can only use this path' },
  behaviorSequence: { label: 'Fixed order', tooltip: 'sequence: the path is replayed step by step' },

  // Edge actions
  reinforce: { label: 'Strengthen', tooltip: 'Reinforce: make this path more important' },
  weaken: { label: 'Weaken', tooltip: 'Weaken: make this path less important' },
  strength: { label: 'Amount' },
  unpin: { label: 'Delete', tooltip: 'Delete this saved path and the edges it created; real run history stays' },

  // Memory operations
  stats: { label: 'Numbers' },
  backup: { label: 'Create backup', tooltip: 'Backup' },
  restore: { label: 'Restore from backup', tooltip: 'Restore' },
  exportWorkflow: { label: 'Export workflow' },
  importWorkflow: { label: 'Import workflow' },
  reset: { label: 'Reset memory', tooltip: 'Reset: delete everything learned' },
  avgStrength: { label: 'Average pheromone' },
  tasks: { label: 'Tasks', tooltip: 'completed loop runs' },
  pinnedPathsCount: { label: 'Saved paths' },

  // Settings
  substratePathField: { label: 'Memory file location (empty = default)', tooltip: 'Substrate path: the SQLite file' },
  workflowRootField: { label: 'Folder for exported workflows', tooltip: 'Where "Export workflow" writes by default' },
  skillRootField: { label: 'Skills folder (for Add tools)', tooltip: 'Discover scans this folder for SKILL.md files' },
  embeddingProviderField: { label: 'Semantic indexing model', tooltip: 'Studio-owned embedding model; fake = light/offline, transformers = a local model' },
  embeddingModelField: { label: 'Embedding model id (optional)', tooltip: 'Hugging Face model id when using transformers; empty = default' },
  namingProviderField: { label: 'Naming LLM provider', tooltip: 'Studio-owned LLM for path names and descriptions; none = fallback id-names' },
  namingModelField: { label: 'Naming model', tooltip: 'Model id for the naming provider' },
  namingApiKeyField: { label: 'Naming API key', tooltip: 'Stored encrypted via the OS keychain (Electron safeStorage)' },
  namingBaseUrlField: { label: 'Naming base URL (optional)', tooltip: 'Override the provider endpoint, e.g. a local Ollama' },
  decayHalfLife: { label: 'Fade time (hours)', tooltip: 'Decay half-life: how fast unused paths fade' },
  tauMin: { label: 'Min strength', tooltip: 'tauMin' },
  tauMax: { label: 'Max strength', tooltip: 'tauMax' },
  explorationPolicy: { label: 'Selection strategy', tooltip: 'Exploration policy' },
  heterogeneousEvaluator: { label: 'Multi-perspective scoring', tooltip: 'Heterogeneous evaluator' },
}

// Widen every value to UiLabel (so .tooltip is always accessible) while keeping the specific keys.
export const LABELS: Record<keyof typeof RAW_LABELS, UiLabel> = RAW_LABELS

export type LabelKey = keyof typeof RAW_LABELS

/** Keys that rename a technical term and must therefore carry a tooltip (so the jargon stays
 * discoverable). Asserted by the test, so a future label addition cannot silently drop the tooltip. */
export const JARGON_KEYS: readonly LabelKey[] = [
  'navSubstrate',
  'capabilities',
  'capability',
  'pinned',
  'editModeOn',
  'behaviorPreferred',
  'behaviorEnforce',
  'behaviorSequence',
  'reinforce',
  'weaken',
  'unpin',
  'tasks',
  'decayHalfLife',
  'explorationPolicy',
  'heterogeneousEvaluator',
]

export function tip(key: LabelKey): string | undefined {
  return LABELS[key].tooltip
}
