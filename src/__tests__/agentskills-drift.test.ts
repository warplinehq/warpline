/**
 * The drift script's exit contract, driven offline.
 *
 * `scripts/check-agentskills-drift.sh` fetches the upstream Agent Skills rule
 * sources and compares their sha256 to `.github/agentskills-upstream.sha256`.
 * Its callers read the exit status and nothing else: 0 is a match, 1 is drift
 * (a changed hash, a missing or empty hash file, any HTTP status other than
 * 200), 3 is a network failure. A caller that wants to warn on 3 and block on 1
 * is only as right as that split, so every arm is pinned here.
 *
 * Two mechanisms keep the tests off the network and off the tracked tree.
 *
 * The script resolves its repository root from its own location, so each case
 * copies it into a `mkdtemp` tree. The copy makes the temp tree the repository
 * it measures, and the hash file each case writes there is the only one it can
 * see. The tracked hash file is never touched.
 *
 * A fake `curl` sits first on the child's PATH. It exists only in the `env`
 * handed to that one child process: bun runs every file of a shard in one
 * process, so assigning the parent's PATH would leak the fake into unrelated
 * tests. The script gains no override knob for this. It calls `curl` exactly as
 * it does in production and the shim answers.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = 'scripts/check-agentskills-drift.sh'
const HOOK = '.githooks/pre-push'
const WORKFLOW = '.github/workflows/agentskills-drift.yml'
const HASH_FILE = '.github/agentskills-upstream.sha256'

const BODY = 'name: fixture\ndescription: bytes the fake curl serves for every URL\n'
const BODY_SHA = createHash('sha256').update(BODY).digest('hex')
const BASE = 'https://raw.githubusercontent.com/agentskills/agentskills/main/'
const URLS = [
  `${BASE}docs/specification.mdx`,
  `${BASE}skills-ref/src/skills_ref/validator.py`,
  `${BASE}skills-ref/src/skills_ref/parser.py`,
  'https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/scripts/quick_validate.py',
]

/**
 * Walks curl's argument list the way the script calls it: `-o` names the
 * output file, `-w`, `--connect-timeout` and `--max-time` take a value that is
 * skipped, other flags are skipped, and the one remaining argument is the URL.
 * The URL is written to the log with printf and never evaluated.
 */
const FAKE_CURL = `#!/usr/bin/env bash
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ -n "\${FAKE_CURL_LOG:-}" ]; then printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"; fi
if [ -n "\${FAKE_CURL_EXIT:-}" ]; then
  echo "curl: (\${FAKE_CURL_EXIT}) simulated failure" >&2
  exit "$FAKE_CURL_EXIT"
fi
cp "$FAKE_CURL_BODY" "$out"
printf '%s' "\${FAKE_CURL_STATUS:-200}"
`

/**
 * A throwaway repository holding a copy of the script, a hash file when
 * `hashText` is non-null, the fixture body and the fake curl. With `hook`, the
 * pre-push hook is copied beside them, so it resolves the copied script.
 */
function driftTree(hashText: string | null, hook = false): string {
  const root = mkdtempSync(join(tmpdir(), 'warpline-drift-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, '.github'))
  mkdirSync(join(root, 'bin'))
  copyFileSync(join(REPO_ROOT, SCRIPT), join(root, SCRIPT))
  if (hook) {
    mkdirSync(join(root, '.githooks'))
    copyFileSync(join(REPO_ROOT, HOOK), join(root, HOOK))
  }
  if (hashText !== null) writeFileSync(join(root, HASH_FILE), hashText)
  writeFileSync(join(root, 'body'), BODY)
  writeFileSync(join(root, 'bin', 'curl'), FAKE_CURL)
  chmodSync(join(root, 'bin', 'curl'), 0o755)
  return root
}

/**
 * Exit status and stdout and stderr together, however the run ended. `entry`
 * is the script or the hook. `spawnSync`, not `execFileSync`: the hook's
 * warning goes to stderr on a zero exit, which `execFileSync` would drop.
 */
function runDrift(root: string, env: Record<string, string> = {}, entry = SCRIPT): { status: number; output: string } {
  const r = spawnSync('bash', [entry], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_CURL_BODY: join(root, 'body'),
      FAKE_CURL_LOG: join(root, 'curl.log'),
      ...env,
    },
  })
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** The URLs the fake curl was asked for, in order. Empty when it was never called. */
function curlLog(root: string): string[] {
  const log = join(root, 'curl.log')
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

/** Every file name under `dir`, recursively. */
function allNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? [d.name, ...allNames(join(dir, d.name))] : [d.name],
  )
}

const line = (hash: string, url: string): string => `${hash}  ${url}\n`
const MATCHING = URLS.map((u) => line(BODY_SHA, u)).join('')

/** Build a tree, run the script (or the hook), hand both to `check`, and always remove the tree. */
function withDrift(
  hashText: string | null,
  env: Record<string, string>,
  check: (r: { status: number; output: string }, root: string) => void,
  entry = SCRIPT,
): void {
  const root = driftTree(hashText, entry === HOOK)
  try {
    check(runDrift(root, env, entry), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the drift script', () => {
  test('matching bytes for every line exit 0 and report the count', () => {
    withDrift(MATCHING, {}, (r, root) => {
      expect(r.output).toContain(`OK: ${URLS.length} upstream files match their committed hashes`)
      expect(r.status).toBe(0)
      expect(curlLog(root)).toEqual(URLS)
    })
  })

  test('a changed hash on one line exits 1 naming that URL', () => {
    const text = [line(BODY_SHA, URLS[0]), line('0'.repeat(64), URLS[1]), line(BODY_SHA, URLS[2])].join('')
    withDrift(text, {}, (r) => {
      expect(r.status).toBe(1)
      expect(r.output).toContain(`drift: ${URLS[1]} changed`)
    })
  })

  // curl exits 0 on a 404 when it is not asked to fail on errors. The status
  // alone decides, and a moved file is drift, not a network blip.
  test('HTTP 404 with curl exit 0 is drift (exit 1), not network', () => {
    withDrift(MATCHING, { FAKE_CURL_STATUS: '404' }, (r) => {
      expect(r.status).toBe(1)
      expect(r.output).toContain('HTTP 404')
    })
  })

  // 6 cannot resolve host, 7 cannot connect, 28 timeout.
  for (const rc of ['6', '7', '28']) {
    test(`curl exit ${rc} is a network failure (exit 3)`, () => {
      withDrift(MATCHING, { FAKE_CURL_EXIT: rc }, (r) => {
        expect(r.status).toBe(3)
        expect(r.output).toContain('network failure')
      })
    })
  }

  test('a missing hash file exits 1 without fetching', () => {
    withDrift(null, {}, (r, root) => {
      expect(r.status).toBe(1)
      expect(curlLog(root)).toEqual([])
    })
  })

  test('an empty hash file exits 1 without fetching', () => {
    withDrift('', {}, (r, root) => {
      expect(r.status).toBe(1)
      expect(curlLog(root)).toEqual([])
    })
  })

  test('a URL outside raw.githubusercontent.com exits 1 without fetching', () => {
    withDrift(line(BODY_SHA, 'https://example.com/spec.mdx'), {}, (r, root) => {
      expect(curlLog(root)).toEqual([])
      expect(r.status).toBe(1)
      expect(r.output).toContain('refusing a URL outside https://raw.githubusercontent.com/')
    })
  })

  test('a 63-character hash exits 1 without fetching', () => {
    withDrift(line(BODY_SHA.slice(1), URLS[0]), {}, (r, root) => {
      expect(r.status).toBe(1)
      expect(curlLog(root)).toEqual([])
    })
  })

  test('a URL carrying $(…) reaches curl literally and runs nothing (PWNED stays absent)', () => {
    const hostile = 'https://raw.githubusercontent.com/x/$(touch PWNED)'
    withDrift(line(BODY_SHA, hostile), {}, (r, root) => {
      expect(r.status).toBe(0)
      expect(allNames(root)).not.toContain('PWNED')
      expect(curlLog(root)).toEqual([hostile])
    })
  })

  test('the last line is checked even without a trailing newline', () => {
    const last = URLS[URLS.length - 1]
    const text = `${URLS.slice(0, -1).map((u) => line(BODY_SHA, u)).join('')}${'0'.repeat(64)}  ${last}`
    withDrift(text, {}, (r, root) => {
      expect(r.status).toBe(1)
      expect(r.output).toContain(`drift: ${last} changed`)
      expect(curlLog(root)).toEqual(URLS)
    })
  })
})

// The hook's whole job is the split: block on 1, warn and pass on 3. A hook
// that mapped every non-zero to 0 would pass the network rows, so the drift,
// 404 and missing-file rows are the ones that prove it propagates.
describe('the pre-push hook', () => {
  test('matching bytes let the push through (exit 0)', () => {
    withDrift(MATCHING, {}, (r) => expect(r.status).toBe(0), HOOK)
  })

  test('a changed upstream hash fails the push (exit 1)', () => {
    withDrift(MATCHING.replace(BODY_SHA, '0'.repeat(64)), {}, (r) => expect(r.status).toBe(1), HOOK)
  })

  test('HTTP 404 fails the push (exit 1)', () => {
    withDrift(MATCHING, { FAKE_CURL_STATUS: '404' }, (r) => expect(r.status).toBe(1), HOOK)
  })

  for (const rc of ['6', '28']) {
    test(`curl exit ${rc} warns on stderr and lets the push through (exit 0)`, () => {
      withDrift(
        MATCHING,
        { FAKE_CURL_EXIT: rc },
        (r) => {
          expect(r.status).toBe(0)
          expect(r.output).toContain('WARNING')
        },
        HOOK,
      )
    })
  }

  test('a missing hash file fails the push (exit 1)', () => {
    withDrift(null, {}, (r) => expect(r.status).toBe(1), HOOK)
  })
})

describe('the hook is opt-in and executable', () => {
  // git skips a hook without the executable bit, silently. The index mode is
  // what a fresh clone gets, so that is what is read, not the local file mode.
  for (const path of [HOOK, SCRIPT]) {
    test(`${path} is tracked as mode 100755`, () => {
      const entry = execFileSync('git', ['ls-files', '-s', path], { cwd: REPO_ROOT, encoding: 'utf8' })
      expect(entry.startsWith('100755 ')).toBe(true)
    })
  }

  // Installing the hook runs network code on every push, so it is the
  // maintainer's explicit `git config core.hooksPath .githooks`, never a
  // lifecycle script that runs on install.
  test('no package.json script installs it', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const value of Object.values(scripts)) {
      expect(value).not.toContain('hooksPath')
      expect(value).not.toContain('.githooks')
    }
    expect(scripts.prepare).toBeUndefined()
    expect(scripts.postinstall).toBeUndefined()
  })
})

// Parsed, never grepped, so a comment can neither satisfy nor break these.
// Unlike link-check this job is not advisory: a fetch failure must fail it
// too, because a check that could not look must not read as one that passed.
describe('the drift workflow', () => {
  type Step = { uses?: string; run?: string; 'continue-on-error'?: unknown }
  type Job = { steps: Step[]; 'continue-on-error'?: unknown }
  const wf = Bun.YAML.parse(readFileSync(join(REPO_ROOT, WORKFLOW), 'utf8')) as {
    on: { schedule?: unknown[]; workflow_dispatch?: unknown }
    permissions: unknown
    jobs: Record<string, Job>
  }
  const jobs = Object.values(wf.jobs)
  const steps = jobs.flatMap((j) => j.steps)

  test('runs on a schedule and on demand', () => {
    expect(Array.isArray(wf.on.schedule) && wf.on.schedule.length > 0).toBe(true)
    expect('workflow_dispatch' in wf.on).toBe(true)
  })

  test('reads the repository and nothing more', () => {
    expect(wf.permissions).toEqual({ contents: 'read' })
  })

  test('no job or step carries on past a failure', () => {
    expect(jobs.length).toBeGreaterThan(0)
    for (const x of [...jobs, ...steps]) expect(x['continue-on-error']).toBeUndefined()
  })

  test('every action is pinned to a full commit SHA', () => {
    const uses = steps.flatMap((s) => (s.uses === undefined ? [] : [s.uses]))
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
  })

  test('exactly one step runs the drift script', () => {
    expect(steps.filter((s) => s.run === `bash ${SCRIPT}`)).toHaveLength(1)
  })
})
