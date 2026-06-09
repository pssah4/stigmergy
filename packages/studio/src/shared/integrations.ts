// Integration registry (FEAT-03-08, ADR-16). Stigmergy is general-purpose: a pinned path is a
// portable workflow, and "Export/Import workflow" are the generic actions. Named integrations
// (Vault Operator is one) are OPTIONAL entries here, not baked into the default UI. An integration
// only adds a known subdirectory under the workflow root plus an optional setup hint. Imported by
// both the renderer (browser bundle) and the main process, so it uses no node: builtins (a plain
// '/' join, fine for a dialog default path). The monorepo vitest covers it.

export interface IntegrationHint {
  doc: string
  snippet: string
}

export interface IntegrationConfig {
  id: string
  name: string
  /** Subdirectory under the workflow root where this integration expects workflow files. */
  subdir: string
  /** Optional setup hint (doc link plus snippet) shown in the connect UI. */
  hint?: IntegrationHint
}

/** Built-in, optional named integrations. Vault Operator is one of them; the default UI does not
 * privilege it. A consumer opts in by selecting it; nothing is baked into the core flows. */
export const BUILTIN_INTEGRATIONS: readonly IntegrationConfig[] = [
  {
    id: 'vault-operator',
    name: 'Vault Operator',
    subdir: '.vault-operator/workflows',
    hint: {
      doc: 'https://github.com/stigmergy/docs/vault-operator',
      snippet: [
        '// Vault Operator integrates Stigmergy as a build-time library.',
        "import { createEngine } from '@agentic-stigmergy/core'",
        "import { BetterSqlite3Storage } from '@stigmergy/storage-better-sqlite3'",
        'const engine = await createEngine({ storage: new BetterSqlite3Storage(substratePath), embedding })',
        '// hand the engine to the Vault Operator runtime; it consults and emits like any loop.',
      ].join('\n'),
    },
  },
]

export function findIntegration(id: string | undefined): IntegrationConfig | undefined {
  return id ? BUILTIN_INTEGRATIONS.find((i) => i.id === id) : undefined
}

/** Resolve the directory to write/read a workflow: <workflowRoot>/<integration.subdir> when an
 * integration is chosen, else <workflowRoot>. An empty workflow root yields '' (the caller then lets
 * the user pick a directory in the file dialog), so nothing is assumed about the filesystem. */
export function resolveWorkflowDir(workflowRoot: string, integrationId?: string): string {
  if (workflowRoot.trim() === '') return ''
  const integration = findIntegration(integrationId)
  if (!integration) return workflowRoot
  return `${workflowRoot.replace(/[/\\]+$/, '')}/${integration.subdir}`
}
