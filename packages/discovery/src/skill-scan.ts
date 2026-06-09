// SKILL.md discovery driver (ADR-17, FEAT-04-02). Walks a directory tree for SKILL.md files, parses
// their frontmatter, and normalizes each to a 'skill' capability. Uses node:fs, so it lives apart
// from the pure normalizers in index.ts; discovery is host-side (CLI / Electron main), never the
// renderer. Best-effort: a missing root or an unreadable file is skipped, never thrown.
import { readdir, readFile } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import type { RegisterCapabilityInput } from '@agentic-stigmergy/core'
import { skillFileToCapability, type SkillFrontmatter } from './index.js'

/** Parse the leading `--- ... ---` YAML frontmatter of a SKILL.md for name/description. Minimal and
 * line-based (no YAML dependency): only top-level `name:` and `description:` scalars are read. */
export function parseFrontmatter(md: string): SkillFrontmatter {
  const text = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const front: SkillFrontmatter = {}
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^(name|description):\s*(.*)$/)
    if (kv) {
      const value = kv[2]!.trim().replace(/^["']|["']$/g, '')
      if (kv[1] === 'name') front.name = value
      else front.description = value
    }
  }
  return front
}

/** Derive a stable slug from a SKILL.md path: its containing directory name (skills live in
 * `<root>/<slug>/SKILL.md`), falling back to a kebab of the frontmatter name. */
function slugFor(filePath: string, front: SkillFrontmatter): string {
  const dir = basename(dirname(filePath))
  if (dir && dir !== '.' && dir !== '') return dir
  return (front.name ?? 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

async function findSkillFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await findSkillFiles(full)))
    else if (e.isFile() && e.name === 'SKILL.md') out.push(full)
  }
  return out
}

/** Walk a directory tree for SKILL.md files and normalize each to a 'skill' capability registration. */
export async function scanSkillDirectory(root: string): Promise<RegisterCapabilityInput[]> {
  const files = await findSkillFiles(root)
  files.sort() // stable order, independent of filesystem enumeration
  const out: RegisterCapabilityInput[] = []
  for (const file of files) {
    try {
      const md = await readFile(file, 'utf8')
      const front = parseFrontmatter(md)
      out.push(skillFileToCapability(slugFor(file, front), front))
    } catch {
      // unreadable file: skip (best-effort)
    }
  }
  return out
}
