// @stigmergy/discovery: host-side capability discovery (ADR-17, FEAT-04-02). Pure normalizers turn
// three sources, host-declared tools, MCP server tools (tools/list), and on-disk SKILL.md files,
// into RegisterCapabilityInput rows tagged with their provenance, so the Builder can show available
// capabilities before they ever run. The MCP transport and the filesystem scan live in their own
// thin drivers; these normalizers are pure and need neither, so the monorepo vitest covers them.
import type { CapabilityType, RegisterCapabilityInput, StigmergyEngine } from '@agentic-stigmergy/core'

export { scanSkillDirectory, parseFrontmatter } from './skill-scan.js'
export { discoverMcpTools, type McpServerConfig, type McpClientLike, type McpConnect } from './mcp-discovery.js'

// Hardening (AUDIT EPIC-04 M-2, L-1): discovery ingests metadata from third-party MCP servers and
// on-disk SKILL.md files. A connected server's tools/list is a semi-trusted boundary, so identifiers
// and descriptions are sanitized (control characters stripped, length clamped) before they become
// capability rows that get embedded, shown in the UI, and interpolated into the naming LLM prompt.
const MAX_ID_LEN = 200
const MAX_DESC_LEN = 500
const MAX_SCHEMA_PROPS = 20
/** Max capabilities registered in one discovery run; beyond this, extra rows are dropped (counted as
 * skipped), so a hostile server returning a huge tools/list cannot bloat the substrate unbounded. */
export const MAX_DISCOVERED = 1000

/** Strip control characters (keep normal spaces) and clamp length, so discovered text is safe to
 * embed, render and feed to the naming prompt. */
function sanitizeText(value: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

/** A tool the host already knows about (its declared tool set). */
export interface HostTool {
  id: string
  type?: CapabilityType
  description?: string
}

/** Map a host-declared tool to a 'declared' capability registration. */
export function hostToolToCapability(tool: HostTool): RegisterCapabilityInput {
  return { id: tool.id, type: tool.type ?? 'tool', description: tool.description ?? '', source: 'declared' }
}

/** One entry from an MCP server's tools/list response. */
export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

/** Summarize a JSON-Schema's top-level property names so an unobserved MCP tool still has a
 * meaningful description to embed. Defensive: any non-object schema yields no summary. */
export function summarizeSchema(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return ''
  const props = (schema as { properties?: unknown }).properties
  if (!props || typeof props !== 'object') return ''
  // Cap the property count so a hostile schema with thousands of keys cannot blow up the description.
  const names = Object.keys(props as Record<string, unknown>).slice(0, MAX_SCHEMA_PROPS)
  return names.length ? ` (params: ${names.join(', ')})` : ''
}

/** Map one MCP tool to an 'mcp' capability, namespaced by its server so ids never collide. The name
 * and description come from a semi-trusted server, so both are sanitized (AUDIT EPIC-04 M-2, L-1). */
export function mcpToolToCapability(server: string, tool: McpTool): RegisterCapabilityInput {
  const name = sanitizeText(tool.name, MAX_ID_LEN)
  const description = sanitizeText(`${tool.description ?? tool.name}${summarizeSchema(tool.inputSchema)}`, MAX_DESC_LEN)
  return { id: `mcp:${server}:${name}`, type: 'mcp', description, source: 'mcp' }
}

/** The frontmatter fields a SKILL.md carries that matter for discovery. */
export interface SkillFrontmatter {
  name?: string
  description?: string
}

/** Map a parsed SKILL.md to a 'skill' capability. The slug is the stable id suffix. The slug and
 * description come from an on-disk file, so both are sanitized (AUDIT EPIC-04 M-2, L-1). */
export function skillFileToCapability(slug: string, front: SkillFrontmatter): RegisterCapabilityInput {
  const description = sanitizeText(front.description ?? front.name ?? slug, MAX_DESC_LEN)
  return { id: `skill:${sanitizeText(slug, MAX_ID_LEN)}`, type: 'skill', description, source: 'skill' }
}

/** Register a batch of discovered capabilities idempotently and report the counts. An entry with an
 * empty or non-string id is skipped, so one malformed source row never throws out of a discovery run
 * (the host stays the trust anchor; a bad row is dropped, not fatal). Registration is capped at
 * MAX_DISCOVERED (AUDIT EPIC-04 L-1): a hostile server returning a huge tools/list cannot bloat the
 * substrate unbounded; rows beyond the cap are counted as skipped. */
export async function ingestDiscovered(
  engine: Pick<StigmergyEngine, 'registerCapability'>,
  inputs: readonly RegisterCapabilityInput[],
): Promise<{ registered: number; skipped: number }> {
  let registered = 0
  let skipped = 0
  for (const input of inputs) {
    if (!input || typeof input.id !== 'string' || input.id.trim() === '') {
      skipped++
      continue
    }
    if (registered >= MAX_DISCOVERED) {
      skipped++ // over the cap: drop the rest rather than bloat the substrate
      continue
    }
    await engine.registerCapability(input)
    registered++
  }
  return { registered, skipped }
}
