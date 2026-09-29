/**
 * The issue scan, executed end to end.
 *
 * An issue title and body are public the moment they are submitted, and `git
 * ls-files` never reaches them, so the guard in `no-private-planning-refs.test.ts`
 * has never seen one. `.github/workflows/issue-scan.yml` is the only screen they
 * pass through. It pipes both fields into `scripts/scan-public-surfaces.sh`.
 *
 * The step is executed here, not grepped. A misspelled field in the pipe
 * yields nothing, so the scan passes on half the text and reads green while
 * blind. Only running the step's own `run:` string against an event payload
 * file, the way the runner hands one over, can tell those apart. The run
 * happens in a temp tree that holds only the scanner, the committed list and
 * the payload, so a holder's local `.private-terms` cannot make a local run
 * disagree with CI.
 *
 * The text comes from the payload file and never from `env:`. The runner
 * prints every step's `env:` block, values included, into the public log, and
 * masks only registered secrets. So the pin below refuses any expression in
 * any `env:` of this workflow, and a test that fed the step through env vars
 * would be testing the leaking shape.
 *
 * What the workflow cannot do is stated here as it is in the workflow: it runs
 * after GitHub has published the issue, so it reports a leak and cannot
 * prevent one. On CI it sees only the committed list. A private name that is
 * also an ordinary word is beyond any list. Comments, pull requests and
 * discussions are not scanned at all.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const WORKFLOW = '.github/workflows/issue-scan.yml'
const FORM = '.github/ISSUE_TEMPLATE/capability_gap.yml'
const SCANNER = 'scripts/scan-public-surfaces.sh'
const NAMES = '.github/private-names.txt'

type Step = {
  name?: string
  uses?: string
  run?: string
  shell?: string
  'working-directory'?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  'continue-on-error'?: unknown
}
type Job = { steps: Step[]; env?: Record<string, unknown>; permissions?: unknown; 'continue-on-error'?: unknown }
type Workflow = { on: Record<string, unknown>; env?: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> }

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

/** The scan step's `run:` string. */
function scanStep(): string {
  return scanStepOf(workflow()).run as string
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
 * `shell: bash` on Linux (pinned below), in a temp tree holding only the scanner, the committed list
 * and an `issues` event payload. The child env is PATH, TMPDIR when set (so the
 * scanner's `mktemp` stays in the test's temp root), and GITHUB_EVENT_PATH.
 * Nothing else leaks in. A `null` body is what GitHub sends for an issue with
 * no body.
 */
function runStep(title: string, body: string | null): { status: number | null; stdout: string; stderr: string } {
  const run = scanStep()
  const root = mkdtempSync(join(tmpdir(), 'warpline-issue-scan-'))
  try {
    for (const rel of [SCANNER, NAMES]) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      copyFileSync(join(REPO_ROOT, rel), join(root, rel))
    }
    const event = join(root, 'event.json')
    writeFileSync(event, JSON.stringify({ action: 'opened', issue: { number: 1, title, body } }))
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', GITHUB_EVENT_PATH: event }
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { cwd: root, encoding: 'utf8', env })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Every `run:` string that holds a workflow expression. An expression inside
 * `run:` is substituted into the script before the shell sees it, so event
 * text there executes. Throws rather than returning `[]` when it could not
 * look: no files, or a file that does not parse.
 */
// ponytail: only `run:` strings are checked, so an action input that evaluates
// code (a `script:` input) would slip past. Check step inputs if one is added.
function runInterpolations(files: readonly { file: string; text: string }[]): string[] {
  if (files.length === 0) throw new Error('could not look: no workflow files')
  const offenders: string[] = []
  for (const { file, text } of files) {
    let wf: { jobs?: Record<string, { steps?: { run?: unknown }[] }> }
    try {
      wf = Bun.YAML.parse(text) as typeof wf
    } catch {
      throw new Error(`could not look: ${file} does not parse`)
    }
    for (const [job, { steps = [] }] of Object.entries(wf.jobs ?? {})) {
      steps.forEach((s, n) => {
        if (typeof s.run === 'string' && s.run.includes('${{')) {
          offenders.push(`${file}: job '${job}' step ${n} interpolates an expression inside run:, where it lands in the shell; read it from the "$GITHUB_EVENT_PATH" payload with jq instead`)
        }
      })
    }
  }
  return offenders
}

/**
 * Every `env:` value, at workflow, job or step level, that resolves event
 * text. The runner prints each step's resolved `env:` into the public log, so
 * a title or body routed through `env:` is copied there, and the log outlives
 * any edit to the text. Read the `$GITHUB_EVENT_PATH` payload instead, which
 * the runner never prints. Throws rather than returning `[]` when it could not
 * look.
 */
function eventTextInEnv(files: readonly { file: string; text: string }[]): string[] {
  if (files.length === 0) throw new Error('could not look: no workflow files')
  type Env = { env?: Record<string, unknown> }
  const offenders: string[] = []
  for (const { file, text } of files) {
    let wf: Env & { jobs?: Record<string, Env & { steps?: Env[] }> }
    try {
      wf = Bun.YAML.parse(text) as typeof wf
    } catch {
      throw new Error(`could not look: ${file} does not parse`)
    }
    const scopes: [string, Env][] = [['workflow', wf]]
    for (const [job, j] of Object.entries(wf.jobs ?? {})) {
      scopes.push([`job '${job}'`, j])
      ;(j.steps ?? []).forEach((s, n) => scopes.push([`job '${job}' step ${n}`, s]))
    }
    for (const [where, { env }] of scopes) {
      for (const [k, v] of Object.entries(env ?? {})) {
        if (/\$\{\{[^}]*github\.event\b/.test(String(v))) {
          offenders.push(`${file}: ${where} env ${k} resolves event text, which the runner prints into the log; read it from the "$GITHUB_EVENT_PATH" payload with jq instead`)
        }
      }
    }
  }
  return offenders
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

  // GNU grep, the one on a CI runner, calls input holding a NUL "binary",
  // prints no matching line and exits 0. `jq -r` turns a `\u0000` escape in
  // the payload into a raw NUL, so a reporter can put one there.
  test('a private name on a line holding a NUL is still reported at its line', () => {
    const planted = `The ${SAMPLE}\u0000 plugin needs to wait for a reviewer.`
    const body = renderSubmission({ capability: planted })
    const line = 1 + body.split('\n').indexOf(planted) + 1
    expect(line).toBeGreaterThan(1)
    const r = runStep(NEUTRAL_TITLE, body)
    expect(reproduces(r)).toBe(false)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('FAIL:')
    expect(r.stderr.split('\n')).toContain(`  line ${line}`)
  })

  test('an issue with an empty body is still scanned on its title and never reads blind', () => {
    for (const body of [null, '']) {
      const r = runStep(NEUTRAL_TITLE, body)
      expect(r.stderr).not.toContain('blind:')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('OK: scanned 2 lines')
    }
  })

  // The hardening pins. Parsed, never grepped, so a comment can neither
  // satisfy nor break them.
  const wf = workflow()
  const jobs = Object.values(wf.jobs)
  const steps = jobs.flatMap((j) => j.steps)

  test('runs when an issue is opened or edited, and on nothing else', () => {
    expect(Object.keys(wf.on)).toEqual(['issues'])
    expect((wf.on.issues as { types?: unknown }).types).toEqual(['opened', 'edited'])
  })

  test('reads the repository and nothing more, and no job widens that', () => {
    expect(wf.permissions).toEqual({ contents: 'read' })
    for (const j of jobs) expect(j.permissions).toBeUndefined()
  })

  test('no job or step carries on past a failure', () => {
    expect(jobs.length).toBeGreaterThan(0)
    for (const x of [...jobs, ...steps]) expect(x['continue-on-error']).toBeUndefined()
  })

  // `runStep` runs the step as `bash --noprofile --norc -eo pipefail`, which is
  // what the runner does for `shell: bash`. With no `shell:` the runner uses
  // `bash -e` without pipefail, so a jq failure would hand the scanner an
  // empty read; and a `working-directory:` would move the scanner's path.
  test('the scan step runs under shell: bash from the checkout root', () => {
    const step = scanStepOf(wf)
    expect(step.shell).toBe('bash')
    expect(step['working-directory']).toBeUndefined()
  })

  // Nothing here pushes, so the job token has no reason to sit in .git/config.
  test('every checkout leaves no credentials behind', () => {
    const checkouts = steps.filter((s) => s.uses?.startsWith('actions/checkout@'))
    expect(checkouts.length).toBeGreaterThan(0)
    for (const s of checkouts) expect(s.with?.['persist-credentials']).toBe(false)
  })

  // The reporter's one attestation. `required: true` on a checkbox option sits
  // under the option itself, where no `validations:` check above can see it.
  test("the form's public-safe attestation stays required", () => {
    type Element = { type: string; id?: string; attributes: { options?: { required?: unknown }[] } }
    const form = Bun.YAML.parse(readFileSync(join(REPO_ROOT, FORM), 'utf8')) as { body: Element[] }
    const box = form.body.filter((e) => e.type === 'checkboxes' && e.id === 'public-safe')
    expect(box.length).toBe(1)
    const options = box[0]?.attributes.options ?? []
    expect(options.length).toBeGreaterThan(0)
    for (const o of options) expect(o.required).toBe(true)
  })

  test('every action is pinned to a full commit SHA', () => {
    const uses = steps.flatMap((s) => (s.uses === undefined ? [] : [s.uses]))
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
  })

  // The runner prints each step's resolved `env:` into the public log. Any
  // expression here, at any level, is event text on its way to that log, and
  // this workflow needs none: the scan reads the payload file.
  test('no env: at workflow, job or step level holds an expression', () => {
    const envs = [wf.env, ...jobs.map((j) => j.env), ...steps.map((s) => s.env)]
    const offenders = envs.flatMap((e) => Object.entries(e ?? {})).filter(([, v]) => String(v).includes('${{'))
    expect(offenders.map(([k]) => k)).toEqual([])
  })
})

describe('every tracked workflow keeps event text out of the shell and the log', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '.github/workflows/'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }))

  const fixture = (run: string) => [
    { file: 'fixture.yml', text: `on: issues\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n` },
  ]

  test('every tracked workflow keeps expressions out of run:', () => {
    expect(tracked.length).toBeGreaterThanOrEqual(8)
    expect(runInterpolations(tracked)).toEqual([])
  })

  test('a step that runs echo on the issue title is reported', () => {
    expect(runInterpolations(fixture('echo "${{ github.event.issue.title }}"'))).toHaveLength(1)
  })

  test('a step that reads the title from env is not', () => {
    expect(runInterpolations(fixture('echo "$ISSUE_TITLE"'))).toEqual([])
  })

  test('no tracked workflow routes event text through env:', () => {
    expect(eventTextInEnv(tracked)).toEqual([])
  })

  test('event text in env: is reported at every level, and other expressions are not', () => {
    const text = [
      'on: issues',
      'env:',
      '  A: ${{ github.event.issue.title }}',
      'jobs:',
      '  x:',
      '    runs-on: ubuntu-latest',
      '    env:',
      '      B: ${{ github.event.issue.body }}',
      '    steps:',
      '      - run: true',
      '        env:',
      '          C: ${{ github.event.release.name }}',
      '          TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      '          REF: ${{ github.ref }}',
    ].join('\n')
    expect(eventTextInEnv([{ file: 'fixture.yml', text }]).length).toBe(3)
  })

  test('env: checks "could not look" on no files or an unparsable one', () => {
    expect(() => eventTextInEnv([])).toThrow(/could not look/)
    expect(() => eventTextInEnv([{ file: 'bad.yml', text: 'jobs: [unclosed' }])).toThrow(/could not look: bad.yml does not parse/)
  })

  test('a workflow that does not parse is "could not look"', () => {
    expect(() => runInterpolations([{ file: 'bad.yml', text: 'jobs: [unclosed' }])).toThrow(/could not look: bad.yml does not parse/)
  })

  test('no workflow files is "could not look"', () => {
    expect(() => runInterpolations([])).toThrow(/could not look/)
  })
})
