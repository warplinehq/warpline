/**
 * The issue scan, executed end to end.
 *
 * An issue title and body are public the moment they are submitted, and `git
 * ls-files` never reaches them, so the guard in `no-private-planning-refs.test.ts`
 * has never seen one. `.github/workflows/issue-scan.yml` is the only screen they
 * pass through. It pipes both fields into `scripts/scan-public-surfaces.sh`.
 *
 * The step is executed here, not grepped. A misspelled variable in the pipe
 * expands to nothing, so the scan passes on half the text and reads green
 * while blind. Only running the step's own `run:` string, with the env the
 * workflow declares, can tell those apart. The run happens in a temp tree that
 * holds only the scanner and the committed list, so a holder's local
 * `.private-terms` cannot make a local run disagree with CI.
 *
 * What the workflow cannot do is stated here as it is in the workflow: it runs
 * after GitHub has published the issue, so it reports a leak and cannot
 * prevent one. On CI it sees only the committed list. A private name that is
 * also an ordinary word is beyond any list. Comments, pull requests and
 * discussions are not scanned at all.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const WORKFLOW = '.github/workflows/issue-scan.yml'
const FORM = '.github/ISSUE_TEMPLATE/capability_gap.yml'
const SCANNER = 'scripts/scan-public-surfaces.sh'
const NAMES = '.github/private-names.txt'

const TITLE_EXPR = /^\$\{\{\s*github\.event\.issue\.title\s*\}\}$/
const BODY_EXPR = /^\$\{\{\s*github\.event\.issue\.body\s*\}\}$/

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; 'continue-on-error'?: unknown }
type Job = { steps: Step[]; permissions?: unknown; 'continue-on-error'?: unknown }
type Workflow = { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> }

function workflow(): Workflow {
  return Bun.YAML.parse(readFileSync(join(REPO_ROOT, WORKFLOW), 'utf8')) as Workflow
}

function scanStepOf(wf: Workflow): Step {
  const hits = Object.values(wf.jobs)
    .flatMap((j) => j.steps)
    .filter((s) => typeof s.run === 'string' && s.run.includes(`bash ${SCANNER}`))
  if (hits.length !== 1) throw new Error(`could not look: ${hits.length} steps in ${WORKFLOW} run ${SCANNER}, expected 1`)
  return hits[0] as Step
}

/** The scan step's `run:` string and the env keys that carry the title and body. */
function scanStep(): { run: string; titleVar: string; bodyVar: string } {
  const step = scanStepOf(workflow())
  const env = Object.entries(step.env ?? {})
  const titleVar = env.find(([, v]) => TITLE_EXPR.test(String(v)))?.[0]
  const bodyVar = env.find(([, v]) => BODY_EXPR.test(String(v)))?.[0]
  if (titleVar === undefined) throw new Error(`could not look: no env key in ${WORKFLOW} carries the issue title`)
  if (bodyVar === undefined) throw new Error(`could not look: no env key in ${WORKFLOW} carries the issue body`)
  return { run: step.run as string, titleVar, bodyVar }
}

/**
 * A submission rendered from the form's own fields: `### <label>`, a blank
 * line, the answer, and a blank line between fields. That approximates how
 * GitHub renders a form into the issue body. The scan is line-based, so only
 * line numbers depend on it, and every expected line is computed from this.
 */
function renderSubmission(answers: Record<string, string>): string {
  type Element = { type: string; id?: string; attributes: { label?: string; options?: { label: string }[] } }
  const form = Bun.YAML.parse(readFileSync(join(REPO_ROOT, FORM), 'utf8')) as { body: Element[] }
  return form.body
    .filter((e) => e.type !== 'markdown')
    .map((e) => {
      const answer =
        e.type === 'checkboxes'
          ? `- [X] ${e.attributes.options?.[0]?.label ?? ''}`
          : (answers[e.id ?? ''] ?? 'A plugin needs to wait for a reviewer before its second step runs.')
      return `### ${e.attributes.label ?? ''}\n\n${answer}`
    })
    .join('\n\n')
}

/**
 * Runs the workflow step's own `run:` string under the shell GitHub uses for
 * `run:` on Linux, in a temp tree holding only the scanner and the committed
 * list. The child env is PATH, TMPDIR when set (so the scanner's `mktemp`
 * stays in the test's temp root), and the two variables. Nothing else leaks in.
 */
function runStep(title: string, body: string): { status: number | null; stdout: string; stderr: string } {
  const { run, titleVar, bodyVar } = scanStep()
  const root = mkdtempSync(join(tmpdir(), 'warpline-issue-scan-'))
  try {
    for (const rel of [SCANNER, NAMES]) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      copyFileSync(join(REPO_ROOT, rel), join(root, rel))
    }
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', [titleVar]: title, [bodyVar]: body }
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { cwd: root, encoding: 'utf8', env })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Taken from the committed list at runtime, the same selection
// `no-private-planning-refs.test.ts` makes, so no sample is ever written here.
const SAMPLE = readFileSync(join(REPO_ROOT, NAMES), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .find((l) => /^[a-z][a-z-]*$/.test(l))

const NEUTRAL_TITLE = 'Capability gap: wait for a reviewer between two steps'

/** Checked as a boolean first, so a failure never prints the sample into a log. */
function reproduces(r: { stdout: string; stderr: string }): boolean {
  return SAMPLE !== undefined && (r.stdout.includes(SAMPLE) || r.stderr.includes(SAMPLE))
}

describe('the issue scan workflow', () => {
  test('the committed list has a plain-word sample to plant', () => {
    expect(SAMPLE).toBeDefined()
  })

  test('a neutral submission rendered from the form passes, every line scanned', () => {
    const body = renderSubmission({})
    const r = runStep(NEUTRAL_TITLE, body)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`OK: scanned ${1 + body.split('\n').length} lines`)
  })

  test('a private name in the title is reported at line 1 and not reproduced', () => {
    const r = runStep(`Capability gap: ${SAMPLE}`, renderSubmission({}))
    expect(reproduces(r)).toBe(false)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('FAIL:')
    expect(r.stderr.split('\n')).toContain('  line 1')
  })

  test('a private name in the capability answer is reported at its body line and not reproduced', () => {
    const planted = `The ${SAMPLE} plugin needs to wait for a reviewer.`
    const body = renderSubmission({ capability: `${planted}\nA second, neutral line.` })
    const line = 1 + body.split('\n').indexOf(planted) + 1
    expect(line).toBeGreaterThan(1)
    const r = runStep(NEUTRAL_TITLE, body)
    expect(reproduces(r)).toBe(false)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('FAIL:')
    expect(r.stderr.split('\n')).toContain(`  line ${line}`)
  })

  test('an issue with an empty body is still scanned on its title and never reads blind', () => {
    const r = runStep(NEUTRAL_TITLE, '')
    expect(r.stderr).not.toContain('blind:')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('OK: scanned 2 lines')
  })
})
