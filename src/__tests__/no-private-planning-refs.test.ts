/**
 * Guards the repo against references to the private predecessor's planning
 * system and deployment.
 *
 * Two distinct classes, with different rules:
 *
 *   1. Opaque planning identifiers (decision IDs, threat IDs, phase numbers).
 *      They resolve to nothing a reader of this repo can reach. Harmless in
 *      isolation, corrosive in bulk. `src/` still carries a large backlog, so
 *      those files sit in SWEEP_BACKLOG below and the list only ever shrinks —
 *      a file is removed from it the moment it is cleaned, and re-adding one
 *      is the signal that a rewrite regressed.
 *
 *   2. Private deployment specifics — domain names, plugin names, skill names
 *      belonging to the closed-source deployment this runtime was extracted
 *      from. No backlog and no exceptions: these are a leak, not archaeology.
 *
 * Why this is a test and not a lint script: `bun test` is the command CI runs
 * and the one the contributor guide names, so the check cannot be skipped by
 * forgetting a second command. See .planning/notes/docs-automation-and-diataxis.md.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** This file necessarily contains the patterns it searches for. */
const SELF = 'src/__tests__/no-private-planning-refs.test.ts'

const SCAN_GLOBS = ['docs/**/*.md', 'src/**/*.ts', 'examples/**/*.ts', 'skills/**/*.md']
const SCAN_FILES = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']

/** Class 1 — opaque identifiers from the private planning system. */
const PLANNING_REF = /\b(?:D|T|INTG|OBS|EVD)-\d+(?:-\d+)*\b|\bPhase \d+\b/

/**
 * Class 2 — names belonging to the private deployment. `epc` is deliberately
 * matched only as a whole word: it is an Energy Performance Certificate feed,
 * not a generic term, and a substring match would fire on unrelated words.
 */
const PRIVATE_NAME = new RegExp(
  [
    // API feeds the closed deployment happened to call
    'companies-house', 'ch-client', 'epc', 'posthog', 'hogql', 'supabase', 'govuk',
    // its plugin and skill names
    'intel-(?:brief|scan|report)', 'today-aggregator', 'content-kanban',
    'outreach-(?:drafts|generator)', 'collateral-(?:import|discover)',
    'hypothesis-gen', 'experiment-checker', 'seo-audit',
    // its capability vocabulary, and the repos themselves
    'gsc_\\w+', 'brocade', 'graphify',
  ].map((p) => `\\b${p}\\b`).join('|'),
  'i',
)

/**
 * Files still carrying class-1 refs, being cleaned one commit at a time.
 * REMOVE a path here when you clean that file. Never add one.
 */
const SWEEP_BACKLOG = new Set<string>([
    'docs/board-spec.md',
    'docs/runtime-spec.md',
    'src/bin/warpline.ts',
    'src/board/__tests__/engine-events.test.ts',
    'src/board/__tests__/state-manager.test.ts',
    'src/board/engine-events.ts',
    'src/board/state-manager.ts',
    'src/cli/__tests__/approve.test.ts',
    'src/cli/__tests__/dispatcher.test.ts',
    'src/cli/__tests__/plan-failures.test.ts',
    'src/cli/__tests__/plan-prohibition.test.ts',
    'src/cli/__tests__/plan-render.test.ts',
    'src/cli/__tests__/plan.test.ts',
    'src/cli/__tests__/run-plugin.test.ts',
    'src/cli/__tests__/run-sigint.test.ts',
    'src/cli/__tests__/scaffold.test.ts',
    'src/cli/approve.ts',
    'src/cli/plan-render.ts',
    'src/cli/plan.ts',
    'src/cli/revoke.ts',
    'src/cli/run-plugin.ts',
    'src/cli/scaffold.ts',
    'src/cli/warpline.ts',
    'src/lib/__tests__/fs-atomic.test.ts',
    'src/lib/__tests__/jsonl-logger.test.ts',
    'src/lib/__tests__/lock-healing.test.ts',
    'src/lib/jsonl-logger.ts',
    'src/lib/lock-healing.ts',
    'src/lib/paths-public.ts',
    'src/lib/preferences.ts',
    'src/runtime/__tests__/approval-gate.test.ts',
    'src/runtime/__tests__/engine-headless.test.ts',
    'src/runtime/__tests__/engine-loader.test.ts',
    'src/runtime/__tests__/invoke-plugin-retry.test.ts',
    'src/runtime/__tests__/invoke-plugin-timeout.test.ts',
    'src/runtime/__tests__/run-artifacts.test.ts',
    'src/runtime/__tests__/staleness.test.ts',
    'src/runtime/__tests__/tier.test.ts',
    'src/runtime/engine.ts',
    'src/runtime/invoke-plugin.ts',
    'src/runtime/run-artifacts.ts',
    'src/runtime/staleness.ts',
    'src/runtime/tier.ts',
    'src/schemas/__tests__/plugin-manifest.test.ts',
    'src/schemas/__tests__/skill-result.test.ts',
    'src/schemas/board.ts',
    'src/schemas/engine-state.ts',
    'src/schemas/plugin-manifest.ts',
    'src/schemas/run-log.ts',
    'src/schemas/skill-result.ts',
])

function scan(): Map<string, string[]> {
  const files = new Set(SCAN_FILES)
  for (const pattern of SCAN_GLOBS) {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT })) {
      files.add(f.split('\\').join('/'))
    }
  }
  files.delete(SELF)

  const hits = new Map<string, string[]>()
  for (const file of files) {
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
    const found = lines.flatMap((line, i) =>
      PLANNING_REF.test(line) || PRIVATE_NAME.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
    )
    if (found.length > 0) hits.set(file, found)
  }
  return hits
}

describe('no private planning or deployment references', () => {
  const hits = scan()

  test('no file outside the sweep backlog carries a planning reference', () => {
    const offenders = [...hits].filter(([file]) => !SWEEP_BACKLOG.has(file)).flatMap(([, lines]) => lines)
    expect(offenders).toEqual([])
  })

  test('no file carries a private deployment name — no backlog, no exceptions', () => {
    const offenders = [...hits.values()]
      .flat()
      .filter((line) => PRIVATE_NAME.test(line.slice(line.indexOf(': ') + 2)))
    expect(offenders).toEqual([])
  })

  test('the sweep backlog has no stale entries', () => {
    const stale = [...SWEEP_BACKLOG].filter((file) => !hits.has(file))
    expect(stale).toEqual([])
  })
})
