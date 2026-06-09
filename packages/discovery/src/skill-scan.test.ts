import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, scanSkillDirectory } from './skill-scan.js'

describe('parseFrontmatter', () => {
  it('reads name and description from the leading frontmatter block', () => {
    const md = '---\nname: Humanizer\ndescription: rewrites AI-sounding text\n---\n\n# Body\n'
    expect(parseFrontmatter(md)).toEqual({ name: 'Humanizer', description: 'rewrites AI-sounding text' })
  })
  it('strips wrapping quotes and tolerates CRLF and a BOM', () => {
    const md = '\uFEFF---\r\nname: "Quoted"\r\ndescription: \'single\'\r\n---\r\n'
    expect(parseFrontmatter(md)).toEqual({ name: 'Quoted', description: 'single' })
  })
  it('returns {} when there is no frontmatter', () => {
    expect(parseFrontmatter('# just a heading\n')).toEqual({})
  })
})

describe('scanSkillDirectory', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-scan-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds nested SKILL.md files and maps each to a skill capability (slug = directory name)', async () => {
    await mkdir(join(root, 'humanizer'), { recursive: true })
    await writeFile(join(root, 'humanizer', 'SKILL.md'), '---\nname: Humanizer\ndescription: rewrites text\n---\n')
    await mkdir(join(root, 'group', 'coding'), { recursive: true })
    await writeFile(join(root, 'group', 'coding', 'SKILL.md'), '---\nname: Coding\ndescription: writes code\n---\n')

    const caps = await scanSkillDirectory(root)
    expect(caps.map((c) => c.id).sort()).toEqual(['skill:coding', 'skill:humanizer'])
    const humanizer = caps.find((c) => c.id === 'skill:humanizer')!
    expect(humanizer.type).toBe('skill')
    expect(humanizer.source).toBe('skill')
    expect(humanizer.description).toBe('rewrites text')
  })

  it('returns an empty array for a missing root', async () => {
    expect(await scanSkillDirectory(join(root, 'does-not-exist'))).toEqual([])
  })

  it('returns an empty array for a tree with no SKILL.md', async () => {
    await mkdir(join(root, 'empty'), { recursive: true })
    await writeFile(join(root, 'empty', 'README.md'), 'nothing here')
    expect(await scanSkillDirectory(root)).toEqual([])
  })
})
