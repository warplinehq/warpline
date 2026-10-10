/**
 * `warpline approve --standing` issues a standing grant: held by a named
 * active machine, issued by a named active human, under the gate's fixed caps.
 * Its `grant.issued` record is on disk before the standing grants file is
 * written, and the next advance fires a plugin it covers, naming the grant.
 *
 * Every refusal exits 1 with the whole home unchanged, no record, and its
 * reason on stderr, so a row can only pass for the reason it names.
 *
 * The process carries `WARPLINE_PRINCIPAL=ops` and `USER=ops`, and `ops` is a
 * registered active human, so an issue that took its issuer from the
 * environment would succeed where it must refuse (SPEC R5).
 *
 * Every case gets its own temp home through the shared verb-home helper
 * (AGENTS.md Rule 2), and every principal is seeded before any snapshot, so
 * the audit head moves only for what a case does (P10).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as gate from '../../runtime/approval-gate.js'
import { runAdvance } from '../../runtime/engine.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { standingGrantsPath } from '../../lib/paths.js'
import {
  auditRecords,
  capture,
  failAppendOnce,
  makeVerbHome,
  recordedBefore,
  restoreSpies,
  seedPrincipals,
  snapshotHome,
  type VerbHome,
} from './helpers/verb-home.js'

const DAY = 24 * 60 * 60 * 1000
const KEY = 'WARPLINE_KEY_SENTINEL_9c1e'

let vh: VerbHome
let saved: { principal: string | undefined; user: string | undefined }

const marker = (name: string): string => join(vh.home, 'fired-' + name)

/** A side-effecting session-class plugin whose handler leaves `fired-<name>` in the home. `fields` replace manifest fields. */
function writeMarkerPlugin(name: string, fields: Record<string, unknown> = {}): void {
  const dir = join(vh.home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      name,
      version: '1.0.0',
      description: `${name} fixture plugin`,
      inputs: {},
      outputs: {},
      capabilities: [],
      secrets: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      approval_class: 'session',
      llm_handoff: false,
      side_effects: ['sends_email'],
      ttl_hours: 24,
      dependencies: [],
      timeout_ms: 5000,
      max_parallelism: 1,
      min_tier: 'normal',
      max_retries: 1,
      retry_delay_ms: 2000,
      ...fields,
    })}`,
  )
  writeFileSync(
    join(dir, 'handler.ts'),
    `import { writeFileSync } from 'node:fs'

export async function handler() {
  writeFileSync(${JSON.stringify(marker(name))}, 'x')
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'fixture ok',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

beforeEach(async () => {
  vh = makeVerbHome()
  writeMarkerPlugin('p')
  writeMarkerPlugin('q')
  // ops carries a key from the start, so the key case needs no later edit.
  const added = await capture(['principal', 'add', 'ops', '--type', 'human', '--key', KEY])
  if (added.code !== 0) throw new Error(`principal add ops exited ${added.code}: ${added.stderr}`)
  await seedPrincipals([
    ['alice', 'human'],
    ['ci', 'machine'],
    ['bot', 'machine'],
  ])
  for (const id of ['alice', 'bot']) {
    const r = await capture(['principal', 'disable', id])
    if (r.code !== 0) throw new Error(`principal disable ${id} exited ${r.code}: ${r.stderr}`)
  }
  saved = { principal: process.env.WARPLINE_PRINCIPAL, user: process.env.USER }
  process.env.WARPLINE_PRINCIPAL = 'ops'
  process.env.USER = 'ops'
})

afterEach(() => {
  if (saved.principal === undefined) delete process.env.WARPLINE_PRINCIPAL
  else process.env.WARPLINE_PRINCIPAL = saved.principal
  if (saved.user === undefined) delete process.env.USER
  else process.env.USER = saved.user
  restoreSpies()
  vh.cleanup()
})

/** A valid issue over p and q, with the flags given replacing or adding to the defaults. */
const ISSUE = ['approve', 'p', 'q', '--standing', '--holder', 'ci', '--principal', 'ops', '--hard-max', '30d']

type StoredGrant = gate.StandingGrant

function storedGrants(): StoredGrant[] {
  return (JSON.parse(readFileSync(standingGrantsPath(), 'utf-8')) as gate.StandingStore).grants
}

describe('approve --standing issues', () => {
  test('approve --standing issues a grant the next advance fires under', async () => {
    const r = await capture(['approve', 'p', 'q', '--standing', '--holder', 'ci', '--principal', 'ops', '--hard-max', '90d', '--period', '7d'])
    expect(r.code).toBe(0)

    expect(statSync(standingGrantsPath()).mode & 0o777).toBe(0o600)
    const grants = storedGrants()
    expect(grants.length).toBe(1)
    const grant = grants[0]!
    expect(grant.id).toMatch(/^[0-9a-f]{12}$/)
    expect(grant.issued_at).toBe(grant.period_start)
    expect({
      holder: grant.holder,
      issuer: grant.issuer,
      scopes: grant.scopes,
      period_ms: grant.period_ms,
      hard_max_ms: grant.hard_max_ms,
    }).toEqual({ holder: 'ci', issuer: 'ops', scopes: ['p', 'q'], period_ms: 7 * DAY, hard_max_ms: 90 * DAY })

    expect(auditRecords(vh.home, 'grant.issued')).toEqual([
      {
        kind: 'standing',
        id: grant.id,
        holder: 'ci',
        principal: 'ops',
        scopes: ['p', 'q'],
        period_ms: 7 * DAY,
        hard_max_ms: 90 * DAY,
      },
    ])

    expect(r.stdout).toContain(grant.id)
    expect(r.stdout).toContain('hard maximum')
    expect(r.stdout).toContain('standing-grants.json')

    // The next advance fires p under that grant, and its intent names it.
    const realPaths = _getPaths()
    const eventsPath = join(vh.home, 'runs', 'events.jsonl')
    mkdirSync(join(vh.home, 'runs'), { recursive: true })
    _setPaths(pathsForStateFile(vh.statePath, { eventsPath }))
    try {
      const result = await runAdvance({
        pluginsDir: join(vh.home, 'plugins'),
        stateDir: vh.statePath,
        runsDir: join(vh.home, 'runs'),
        eventsPath,
        preferencesPath: join(vh.home, 'preferences.json'),
        now: Date.now(),
      })
      expect(result.plugin_states.get('p')).toBe('completed')
    } finally {
      _setPaths(realPaths)
    }
    expect(existsSync(marker('p'))).toBe(true)
    const intent = auditRecords(vh.home, 'fire.intent').find((d) => d.plugin === 'p')
    expect(intent).toBeDefined()
    expect(intent!.grants).toContainEqual({ kind: 'standing', id: grant.id, holder: 'ci', issuer: 'ops' })
  })

  test('approve --standing records before it writes', async () => {
    const seen = recordedBefore(gate as unknown as Record<string, unknown>, 'writeStandingStore', vh.home, 'grant.issued')
    const r = await capture(ISSUE)
    expect(r.code).toBe(0)
    expect(seen()).toBe(true)
  })

  test('approve --standing defaults the period to a day', async () => {
    const r = await capture(ISSUE)
    expect(r.code).toBe(0)
    expect(storedGrants()[0]!.period_ms).toBe(86400000)
  })
})

/** The ISSUE argv with `flag` dropped (and its value, when it has one). */
function without(flag: string, argv: string[] = ISSUE): string[] {
  const i = argv.indexOf(flag)
  if (i < 0) throw new Error(`${flag} is not in ${argv.join(' ')}`)
  const hasValue = i + 1 < argv.length && !argv[i + 1]!.startsWith('--')
  return [...argv.slice(0, i), ...argv.slice(i + (hasValue ? 2 : 1))]
}

/** The ISSUE argv with `flag`'s value replaced. */
function withValue(flag: string, value: string, argv: string[] = ISSUE): string[] {
  const i = argv.indexOf(flag)
  if (i < 0) return [...argv, flag, value]
  return [...argv.slice(0, i + 1), value, ...argv.slice(i + 2)]
}

const STANDING_TAIL = ['--standing', '--holder', 'ci', '--principal', 'ops', '--hard-max', '30d']

const REFUSALS: ReadonlyArray<readonly [string, string[], string]> = [
  ['--hard-max 91d', withValue('--hard-max', '91d'), 'the hard maximum is over the 90-day cap'],
  ['--period 8d --hard-max 30d', [...ISSUE, '--period', '8d'], 'the renewal period is over the 7-day cap'],
  [
    '--period 2d --hard-max 1d',
    withValue('--hard-max', '1d', [...ISSUE, '--period', '2d']),
    'the hard maximum is shorter than the renewal period',
  ],
  ['no --hard-max', without('--hard-max'), '--hard-max is required'],
  ['--all with --standing', ['approve', '--all', ...STANDING_TAIL], '--all cannot go with --standing'],
  ['a positional *', ['approve', '*', ...STANDING_TAIL], 'a standing grant never covers every plugin'],
  ['--holder nobody', withValue('--holder', 'nobody'), '--holder: no principal has that id'],
  ['--holder bot (disabled)', withValue('--holder', 'bot'), '--holder: that principal is disabled'],
  ['--holder ops (a human)', withValue('--holder', 'ops'), '--holder: that principal is not a machine'],
  ['--principal nobody', withValue('--principal', 'nobody'), '--principal: no principal has that id'],
  ['--principal alice (disabled)', withValue('--principal', 'alice'), '--principal: that principal is disabled'],
  ['--principal ci (a machine)', withValue('--principal', 'ci'), '--principal: that principal is not a human'],
  ['no --principal, WARPLINE_PRINCIPAL set', without('--principal'), '--principal is required'],
  ["--principal ''", withValue('--principal', ''), '--principal: an empty id names no principal'],
  ["--holder ''", withValue('--holder', ''), '--holder: an empty id names no principal'],
  ['--ttl 1h', [...ISSUE, '--ttl', '1h'], '--ttl cannot go with --standing'],
  ['--long', [...ISSUE, '--long'], '--long cannot go with --standing'],
  ['--replace', [...ISSUE, '--replace'], '--replace cannot go with --standing'],
  ['--content', [...ISSUE, '--content'], '--content cannot go with --standing'],
  ['--remove', [...ISSUE, '--remove'], '--remove cannot go with --standing'],
  ['--not-after', [...ISSUE, '--not-after', '2099-01-01T00:00'], '--not-after cannot go with --standing'],
  ['--not-before', [...ISSUE, '--not-before', '2099-01-01T00:00'], '--not-before cannot go with --standing'],
  ['--zone UTC', [...ISSUE, '--zone', 'UTC'], '--zone cannot go with --standing'],
  [
    '--holder without --standing',
    ['approve', 'p', '--holder', 'ci'],
    '--holder, --period and --hard-max only go with --standing',
  ],
  [
    'no positional plugin',
    ['approve', ...STANDING_TAIL],
    'a standing grant names at least one plugin',
  ],
  [
    'a --period the parser reads as Infinity',
    [...ISSUE, '--period', '9'.repeat(400) + 'd'],
    'the renewal period is not a positive whole number of milliseconds',
  ],
]

describe('approve --standing refuses and writes nothing', () => {
  for (const [name, argv, reason] of REFUSALS) {
    test(name, async () => {
      const before = await snapshotHome(vh.home)
      const r = await capture(argv)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(reason)
      expect(auditRecords(vh.home, 'grant.issued')).toEqual([])
      expect(await snapshotHome(vh.home)).toEqual(before)
    })
  }

  // Nothing reads a standing grant for these, so issuing one would show a live
  // grant that authorises nothing.
  for (const [name, fields, plugins, reason] of [
    ['a content-class plugin', { approval_class: 'content', dependencies: ['p'] }, ['c'], 'c is never authorised by a grant'],
    ['a plugin with no side effects', { side_effects: [] }, ['c'], 'c is never authorised by a grant'],
    ['one of two names', { side_effects: [] }, ['p', 'c'], 'c is never authorised by a grant'],
  ] as const) {
    test(`${name} is refused`, async () => {
      writeMarkerPlugin('c', fields)
      const before = await snapshotHome(vh.home)
      const r = await capture(['approve', ...plugins, ...STANDING_TAIL])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(reason)
      expect(auditRecords(vh.home, 'grant.issued')).toEqual([])
      expect(await snapshotHome(vh.home)).toEqual(before)
    })
  }

  test('a new id already in the file is refused', async () => {
    const first = await capture(ISSUE)
    expect(first.code).toBe(0)
    const id = storedGrants()[0]!.id
    const spy = spyOn(gate, 'newStandingId').mockReturnValue(id)
    try {
      const before = await snapshotHome(vh.home)
      const r = await capture(ISSUE)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('that grant id is already in the standing grants file')
      expect(await snapshotHome(vh.home)).toEqual(before)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('approve --standing and the files beside it', () => {
  test('approve --standing over an unreadable standing grants file refuses', async () => {
    writeFileSync(standingGrantsPath(), '{not json')
    const before = await snapshotHome(vh.home)
    const r = await capture(ISSUE)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('approve --standing: the standing grants file cannot be read. Nothing was written.\n')
    expect(await snapshotHome(vh.home)).toEqual(before)
  })

  test('approve --standing whose record cannot be written leaves no store', async () => {
    const { trips } = failAppendOnce('grant.issued')
    const r = await capture(ISSUE)
    expect(r.code).not.toBe(0)
    expect(existsSync(standingGrantsPath())).toBe(false)
    expect(auditRecords(vh.home, 'grant.issued')).toEqual([])
    expect(trips()).toBe(1)
  })

  test('session flags leave a standing grant untouched', async () => {
    const issued = await capture(ISSUE)
    expect(issued.code).toBe(0)
    const bytes = readFileSync(standingGrantsPath())
    const mtime = statSync(standingGrantsPath()).mtimeMs
    for (const argv of [
      ['approve', 'p', '--ttl', '1h'],
      ['approve', 'p', '--long'],
      ['approve', 'p', '--replace'],
      ['approve', '--all'],
    ]) {
      const r = await capture(argv)
      expect(r.code).toBe(0)
      expect(readFileSync(standingGrantsPath()).equals(bytes)).toBe(true)
      expect(statSync(standingGrantsPath()).mtimeMs).toBe(mtime)
    }
  })

  test('no record and no output of an issue carries a key', async () => {
    const r = await capture(ISSUE)
    const lines = auditRecords(vh.home).map((l) => JSON.stringify(l)).join('\n')
    expect(lines).not.toContain(KEY)
    expect(r.stdout).not.toContain(KEY)
    expect(r.stderr).not.toContain(KEY)
  })
})
