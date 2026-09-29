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
 * masks only registered secrets. So the pin below refuses, in every tracked
 * workflow, any `env:` or `with:` expression outside a short allowlist, and a
 * test that fed the step through env vars would be testing the leaking shape.
 * The release workflow's scan step is run the same way, on a release payload.
 *
 * What the workflow cannot do is stated here as it is in the workflow: it runs
 * after GitHub has published the issue, so it reports a leak and cannot
 * prevent one. On CI it sees only the committed list. A private name that is
 * also an ordinary word is beyond any list. Comments, pull requests and
 * discussions are not scanned at all. A failed scan notifies no maintainer.
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

const RELEASE = '.github/workflows/release.yml'

type Vars = Record<string, unknown>
type Step = { name?: string; uses?: string; run?: string; shell?: string; 'working-directory'?: string; with?: Vars; env?: Vars; 'continue-on-error'?: unknown }
type Job = {
  steps?: Step[]
  env?: Vars
  permissions?: unknown
  'continue-on-error'?: unknown
  container?: string | { env?: Vars }
  services?: Record<string, { env?: Vars }>
}
type Workflow = { on: Record<string, unknown>; env?: Vars; permissions: unknown; jobs: Record<string, Job> }
type FormElement = { type: string; id?: string; attributes: { label?: string; value?: string; options?: { label: string; required?: unknown }[] } }

function workflow(file = WORKFLOW): Workflow {
  return Bun.YAML.parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as Workflow
}

function form(): { body: FormElement[] } {
  return Bun.YAML.parse(readFileSync(join(REPO_ROOT, FORM), 'utf8')) as { body: FormElement[] }
}

function scanStepOf(file: string): Step {
  const hits = Object.values(workflow(file).jobs)
    .flatMap((j) => j.steps ?? [])
    .filter((s) => typeof s.run === 'string' && s.run.includes(`bash ${SCANNER}`))
  if (hits.length !== 1) throw new Error(`could not look: ${hits.length} steps in ${file} run ${SCANNER}, expected 1`)
  return hits[0] as Step
}

/**
 * A submission rendered from the form's own fields: `### <label>`, a blank
 * line, the answer, and a blank line between fields. That approximates how
 * GitHub renders a form into the issue body. The scan is line-based, so only
 * line numbers depend on it, and every expected line is computed from this.
 */
function renderSubmission(answers: Record<string, string>): string {
  return form()
    .body.filter((e) => e.type !== 'markdown')
    .map((e) => {
      const answer =
        e.type === 'checkboxes'
          ? `- [X] ${e.attributes.options?.[0]?.label ?? ''}`
          : (answers[e.id ?? ''] ?? 'A plugin needs to wait for a reviewer before its second step runs.')
      return `### ${e.attributes.label ?? ''}\n\n${answer}`
    })
    .join('\n\n')
}

type Run = { status: number | null; stdout: string; stderr: string }

/**
 * Runs `script` under the shell GitHub uses for `shell: bash` on Linux
 * (pinned below), in a temp tree holding only the scanner, the name list and,
 * when given, an event payload. `names` is the list's content, `null` for no
 * list, and the committed list when left out. The child env is PATH, TMPDIR
 * when set (so the scanner's `mktemp` stays in the test's temp root), and
 * GITHUB_EVENT_PATH. Nothing else leaks in, and no `.private-terms` exists, so
 * a holder's local run agrees with CI.
 */
function runInTree(script: string, opts: { event?: unknown; names?: string | null; input?: string }): Run {
  const root = mkdtempSync(join(tmpdir(), 'warpline-issue-scan-'))
  try {
    mkdirSync(join(root, SCANNER, '..'), { recursive: true })
    mkdirSync(join(root, NAMES, '..'), { recursive: true })
    copyFileSync(join(REPO_ROOT, SCANNER), join(root, SCANNER))
    if (opts.names === undefined) copyFileSync(join(REPO_ROOT, NAMES), join(root, NAMES))
    else if (opts.names !== null) writeFileSync(join(root, NAMES), opts.names)
    const event = join(root, 'event.json')
    writeFileSync(event, JSON.stringify(opts.event ?? {}))
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', GITHUB_EVENT_PATH: event }
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: root, encoding: 'utf8', env, input: opts.input ?? '' })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The workflow's own scan step, run against `event` as its payload. */
function runStep(file: string, event: unknown): Run {
  return runInTree(scanStepOf(file).run as string, { event })
}

/** An `issues` event. A `null` body is what GitHub sends for an issue with no body. */
function runIssue(title: string, body: string | null): Run {
  return runStep(WORKFLOW, { action: 'opened', issue: { number: 1, title, body } })
}

function runRelease(name: string, body: string): Run {
  return runStep(RELEASE, { action: 'published', release: { name, body } })
}

/** Parses each file. Throws "could not look" on no files or one that does not parse, never `[]`. */
function parseWorkflows(files: readonly { file: string; text: string }[]): { file: string; wf: Partial<Workflow> }[] {
  if (files.length === 0) throw new Error('could not look: no workflow files')
  return files.map(({ file, text }) => {
    try {
      return { file, wf: (Bun.YAML.parse(text) ?? {}) as Partial<Workflow> }
    } catch {
      throw new Error(`could not look: ${file} does not parse`)
    }
  })
}

/**
 * Every `run:` string that holds a workflow expression. An expression inside
 * `run:` is substituted into the script before the shell sees it, so event
 * text there executes.
 */
function runInterpolations(files: readonly { file: string; text: string }[]): string[] {
  return parseWorkflows(files).flatMap(({ file, wf }) =>
    Object.entries(wf.jobs ?? {}).flatMap(([job, { steps = [] }]) =>
      steps.flatMap((s, n) =>
        typeof s.run === 'string' && s.run.includes('${{')
          ? [`${file}: job '${job}' step ${n} interpolates an expression inside run:, where it lands in the shell; read it from the "$GITHUB_EVENT_PATH" payload with jq instead`]
          : [],
      ),
    ),
  )
}

// The only expressions an `env:` or `with:` value may hold, none of them text
// an outsider writes. `secrets.<NAME>` is masked in the log. `github.ref` and
// `github.sha` are refs the repository names. Tracked uses today: link-check's
// GITHUB_TOKEN (secrets) and its cache key `lychee-${{ github.sha }}`.
const ALLOWED_EXPR = /\$\{\{\s*(?:secrets\.[A-Za-z_][A-Za-z0-9_]*|github\.ref|github\.sha)\s*\}\}/g

/**
 * Every `env:` value (workflow, job, step, `container.env`, `services.*.env`)
 * and every step `with:` value holding an expression outside the allowlist.
 * The runner prints each step's resolved `env:` into the public log, and an
 * action input can land anywhere the action puts it. Matching any `${{` rather
 * than `github.event` catches `format(...)` and `github['event']` spellings
 * too. Read event text from the `$GITHUB_EVENT_PATH` payload instead, which
 * the runner never prints.
 */
// ponytail: a `run:` or `with: script:` elsewhere is caught above or here, but
// an expression in `if:` or a matrix is not read. Extend the scopes if one
// ever carries event text somewhere it is printed.
function exprInEnvOrWith(files: readonly { file: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { file, wf } of parseWorkflows(files)) {
    const scopes: [string, Vars | undefined][] = [['workflow env', wf.env]]
    for (const [job, j] of Object.entries(wf.jobs ?? {})) {
      scopes.push([`job '${job}' env`, j.env])
      if (typeof j.container === 'object') scopes.push([`job '${job}' container.env`, j.container?.env])
      for (const [svc, sv] of Object.entries(j.services ?? {})) scopes.push([`job '${job}' services.${svc}.env`, sv?.env])
      ;(j.steps ?? []).forEach((s, n) => scopes.push([`job '${job}' step ${n} env`, s.env], [`job '${job}' step ${n} with`, s.with]))
    }
    for (const [where, vars] of scopes) {
      for (const [k, v] of Object.entries(vars ?? {})) {
        if (String(v).replace(ALLOWED_EXPR, '').includes('${{')) {
          offenders.push(`${file}: ${where} ${k} holds an expression outside the allowlist; read event text from the "$GITHUB_EVENT_PATH" payload with jq instead`)
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
    const r = runIssue(NEUTRAL_TITLE, body)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`OK: scanned ${1 + body.split('\n').length} lines`)
  })

  test('a private name in the title is reported at line 1 and not reproduced', () => {
    const r = runIssue(`Capability gap: ${SAMPLE}`, renderSubmission({}))
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
    const r = runIssue(NEUTRAL_TITLE, body)
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
    const r = runIssue(NEUTRAL_TITLE, body)
    expect(reproduces(r)).toBe(false)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('FAIL:')
    expect(r.stderr.split('\n')).toContain(`  line ${line}`)
  })

  test('an issue with an empty body is still scanned on its title and never reads blind', () => {
    for (const body of [null, '']) {
      const r = runIssue(NEUTRAL_TITLE, body)
      expect(r.stderr).not.toContain('blind:')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('OK: scanned 2 lines')
    }
  })

  // The hardening pins. Parsed, never grepped, so a comment can neither
  // satisfy nor break them.
  const wf = workflow()
  const jobs = Object.values(wf.jobs)
  const steps = jobs.flatMap((j) => j.steps ?? [])

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

  // `runInTree` runs the step as `bash --noprofile --norc -eo pipefail`, which
  // is what the runner does for `shell: bash`. With no `shell:` the runner uses
  // `bash -e` without pipefail, so a jq failure would hand the scanner an
  // empty read; and a `working-directory:` would move the scanner's path.
  test('both scan steps, issue and release, run under shell: bash from the checkout root', () => {
    for (const file of [WORKFLOW, RELEASE]) {
      const step = scanStepOf(file)
      expect(step.shell).toBe('bash')
      expect(step['working-directory']).toBeUndefined()
    }
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
    const box = form().body.filter((e) => e.type === 'checkboxes' && e.id === 'public-safe')
    expect(box.length).toBe(1)
    const options = box[0]?.attributes.options ?? []
    expect(options.length).toBeGreaterThan(0)
    for (const o of options) expect(o.required).toBe(true)
  })

  // WR-02. GitHub tells only the actor who triggered a run that it failed, and
  // here that is the reporter. With read-only permissions the job cannot label
  // or comment either, so a red run reaches no maintainer. That is a limit, and
  // it is stated where the other limits are: the workflow header and the form's
  // warning, the one text a reporter reads before the issue is public.
  test('the workflow and the form both say a failed scan notifies no maintainer', () => {
    const header = readFileSync(join(REPO_ROOT, WORKFLOW), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('#'))
      .join(' ')
      .replace(/#\s*/g, '')
      .replace(/\s+/g, ' ')
    expect(header).toContain('notifies no maintainer')
    const warning = form().body.find((e) => e.type === 'markdown')?.attributes.value?.replace(/\s+/g, ' ') ?? ''
    expect(warning).toContain('notifies no maintainer')
  })

  test('every action is pinned to a full commit SHA', () => {
    const uses = steps.flatMap((s) => (s.uses === undefined ? [] : [s.uses]))
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
  })
})

// The release scan: the same scanner, fed the release title and body from the
// `release` payload before the upload makes the version permanent.
describe('the release scan step', () => {
  test('a neutral release passes, every line scanned', () => {
    const body = 'Adds a reviewer wait between steps.\n\n- one fix\n- another'
    const r = runRelease('v9.9.9', body)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`OK: scanned ${1 + body.split('\n').length} lines`)
  })

  test('a private name in the release title is reported at line 1 and not reproduced', () => {
    const r = runRelease(`v9.9.9 ${SAMPLE}`, 'A neutral body.')
    expect(reproduces(r)).toBe(false)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('FAIL:')
    expect(r.stderr.split('\n')).toContain('  line 1')
  })
})

// The scanner's own refusals to read green while blind.
describe('the scanner says blind rather than passing', () => {
  const scan = (input: string, names?: string | null) => runInTree(`bash ${SCANNER}`, { input, names })
  for (const [label, input, names] of [
    ['empty stdin', '', undefined],
    ['an absent committed list', 'neutral text', null],
    ['a committed list of only comments and blanks', 'neutral text', '# nothing\n\n'],
  ] as const) {
    test(`on ${label}`, () => {
      const r = scan(input, names)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('blind:')
    })
  }
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

  test('no tracked workflow puts a non-allowlisted expression in env: or with:', () => {
    expect(exprInEnvOrWith(tracked)).toEqual([])
  })

  test('env:/with: expressions are reported at every level, evasive spellings included, and allowlisted ones are not', () => {
    const text = [
      'on: issues',
      'env:',
      "  A: ${{ format('{0}', github.event.issue.title) }}",
      'jobs:',
      '  x:',
      '    runs-on: ubuntu-latest',
      '    container:',
      '      image: alpine',
      '      env:',
      '        B: ${{ github.event.issue.body }}',
      '    services:',
      '      db:',
      '        image: postgres',
      '        env:',
      '          C: ${{ github.head_ref }}',
      '    env:',
      "      D: ${{ github['event'].release.name }}",
      '    steps:',
      '      - uses: actions/github-script@v7',
      '        with:',
      '          script: console.log(${{ toJSON(github.event.issue.title) }})',
      '          key: lychee-${{ github.sha }}',
      '        env:',
      '          TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      '          REF: ${{ github.ref }}',
      '          E: ${{ secrets.X }}-${{ github.event.issue.title }}',
    ].join('\n')
    const found = exprInEnvOrWith([{ file: 'fixture.yml', text }])
    expect(found.map((f) => f.split(' holds')[0])).toEqual([
      'fixture.yml: workflow env A',
      "fixture.yml: job 'x' env D",
      "fixture.yml: job 'x' container.env B",
      "fixture.yml: job 'x' services.db.env C",
      "fixture.yml: job 'x' step 0 env E",
      "fixture.yml: job 'x' step 0 with script",
    ])
  })

  test('both checks are "could not look" on no files or an unparsable one', () => {
    for (const check of [runInterpolations, exprInEnvOrWith]) {
      expect(() => check([])).toThrow(/could not look/)
      expect(() => check([{ file: 'bad.yml', text: 'jobs: [unclosed' }])).toThrow(/could not look: bad.yml does not parse/)
    }
  })
})
