// Config-driven entry point (FEAT-02-03 SC-04, SC-06). executeRunConfig loads a run-config
// file, runs its variants over the referenced workload, and writes a JSON and a Markdown
// report per variant plus a baseline-vs-treatment diff. Storage, embedding and clock are
// injected (RunnerDeps), so the run is deterministic and the package keeps no hard storage
// dependency; the run-config carries the ablation switches, so changing an ablation needs
// no code change.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, join, sep } from 'node:path'
import { parseRunConfig } from './runconfig.js'
import { parseWorkload } from './workload.js'
import { runSweep } from './sweep.js'
import { diffReports, diffToMarkdown, type ReportDiff } from './diff.js'
import { reportToJson, reportToMarkdown, type Report } from './report.js'
import type { RunnerDeps } from './runner.js'

export interface ExecuteResult {
  reports: Report[]
  diff?: ReportDiff
  written: string[]
}

export async function executeRunConfig(
  configPath: string,
  deps: RunnerDeps,
  outDir: string,
  stamp: string,
): Promise<ExecuteResult> {
  const cfg = parseRunConfig(await readFile(configPath, 'utf8'))
  const workloadPath = resolve(dirname(configPath), cfg.workloadFile)
  const w = parseWorkload(await readFile(workloadPath, 'utf8'), cfg.workloadFile)

  const runnerDeps: RunnerDeps = {
    ...deps,
    taskIntervalMs: cfg.taskIntervalMs ?? deps.taskIntervalMs,
    callOverheadTokens: cfg.callOverheadTokens ?? deps.callOverheadTokens,
  }
  const reports = await runSweep(w, cfg.variants, cfg.seed, runnerDeps)

  await mkdir(outDir, { recursive: true })
  const written: string[] = []
  // Defense-in-depth (CWE-22): the report path embeds workload.id and variant.name. Even
  // though both are validated against path separators upstream, assert every output path
  // stays inside outDir so no interpolation can ever escape it.
  const outRoot = resolve(outDir)
  const within = (p: string): string => {
    const r = resolve(p)
    if (r !== outRoot && !r.startsWith(outRoot + sep)) {
      throw new Error(`report path '${p}' escapes the output directory '${outDir}'`)
    }
    return p
  }
  // Variant names are case-sensitively unique, but a case- or Unicode-folding filesystem
  // (APFS, NTFS) would let two reports overwrite each other silently. Detect the fold
  // collision up front and fail loud instead of clobbering a report.
  const seenBases = new Set<string>()
  for (const r of reports) {
    const base = within(join(outDir, `${stamp}-${w.workload.id}-${r.variant.name}`))
    const foldKey = base.normalize('NFC').toLowerCase()
    if (seenBases.has(foldKey)) {
      throw new Error(`report path collision for variant '${r.variant.name}': '${base}' folds onto an already-written report`)
    }
    seenBases.add(foldKey)
    await writeFile(`${base}.json`, reportToJson(r), 'utf8')
    await writeFile(`${base}.md`, reportToMarkdown(r), 'utf8')
    written.push(`${base}.json`, `${base}.md`)
  }

  let diff: ReportDiff | undefined
  if (reports.length >= 2 && reports[0] && reports[1]) {
    diff = diffReports(reports[0], reports[1])
    const dpath = within(join(outDir, `${stamp}-${w.workload.id}-diff.md`))
    await writeFile(dpath, diffToMarkdown(diff), 'utf8')
    written.push(dpath)
  }

  return { reports, diff, written }
}
