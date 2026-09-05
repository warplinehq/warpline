/**
 * The builders are measured at the parse boundary, not at their own return.
 *
 * `skillOk` and `skillFailure` exist to stop 45 hand-built result literals from
 * drifting apart. A unit test that asserts on the object the builder returns
 * cannot see the two things that actually go wrong: a field Zod strips because
 * the schema never declared it, and a default the builder restated by hand and
 * then got wrong. Both are only visible on the far side of
 * `invoke-plugin.ts`'s `safeParse`, so the last case here runs a real fixture
 * handler through `invokePlugin` and reads what the caller receives.
 *
 * The fixture imports the builder by ABSOLUTE path. Plugin fixtures live in a
 * temp directory with no `node_modules` above it, so `warpline/unstable-result`
 * does not resolve from there — the specifier is proven by
 * `scripts/verify-tarball.sh` against a packed tarball, which is the only place
 * it can be proven honestly.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { skillOk, skillFailure } from '../result-builders.js'
import { invokePlugin } from '../invoke-plugin.js'
import { OUTPUT_BODY_CAP_BYTES, SkillResultSchema } from '../../schemas/skill-result.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

const BUILDER_PATH = fileURLToPath(new URL('../result-builders.ts', import.meta.url))

describe('skillOk', () => {
  test('a summary alone produces a result the parse boundary accepts', () => {
    const built = skillOk('did the thing')
    expect(built.status).toBe('success')
    expect(built.summary).toBe('did the thing')

    const parsed = SkillResultSchema.safeParse(built)
    expect(parsed.success).toBe(true)
  })

  test('unmentioned fields land on the schema defaults, not on a second copy of them', () => {
    const parsed = SkillResultSchema.parse(skillOk('did the thing'))

    // The builder sets none of these. If it ever hard-codes one, this is the
    // assertion that notices the day the schema's own default moves.
    expect(parsed.errors).toEqual([])
    expect(parsed.artifacts_produced).toEqual([])
    expect(parsed.schema_version).toBe(2)
    expect(parsed.phases_completed).toEqual([])
    expect(parsed.phases_failed).toEqual([])
    expect(parsed.data_freshness).toEqual({})
  })

  test('overrides set the fields they name and leave the rest defaulted', () => {
    const parsed = SkillResultSchema.parse(
      skillOk('wrote one report', {
        phases_completed: ['collect', 'render'],
        artifacts_produced: [{ type: 'report', format: 'json', path: 'reports/one.json' }],
        reversible: true,
        undo_instruction: 'delete reports/one.json',
      }),
    )

    expect(parsed.phases_completed).toEqual(['collect', 'render'])
    expect(parsed.artifacts_produced).toEqual([
      { type: 'report', format: 'json', path: 'reports/one.json' },
    ])
    expect(parsed.reversible).toBe(true)
    expect(parsed.undo_instruction).toBe('delete reports/one.json')
    expect(parsed.errors).toEqual([])
    expect(parsed.schema_version).toBe(2)
  })

  test('a bare string artifact still reaches the union it belongs to', () => {
    // The arm the schema promises until 1.0. A builder typed against the
    // schema's OUTPUT type would make it unexpressible here, which is the whole
    // reason the return type is the input type.
    const parsed = SkillResultSchema.parse(
      skillOk('wrote one file', { artifacts_produced: ['reports/one.md'] }),
    )

    expect(parsed.artifacts_produced).toEqual([
      { type: 'artifact', format: 'markdown', path: 'reports/one.md' },
    ])
  })

  test('an empty summary is not an error', () => {
    expect(SkillResultSchema.safeParse(skillOk('')).success).toBe(true)
  })

  test('an inline body is measured in UTF-8 bytes, not UTF-16 code units', () => {
    // 4096 four-byte code points: exactly OUTPUT_BODY_CAP_BYTES in UTF-8, and
    // 8192 UTF-16 units. A `.max()` cap would accept both of these; the byte
    // cap accepts only the first. The builder must not open a path around it.
    const atCap = '\u{1F600}'.repeat(OUTPUT_BODY_CAP_BYTES / 4)
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(OUTPUT_BODY_CAP_BYTES)

    expect(
      SkillResultSchema.safeParse(
        skillOk('at the cap', { artifacts_produced: [{ type: 'brief', body: atCap }] }),
      ).success,
    ).toBe(true)

    expect(
      SkillResultSchema.safeParse(
        skillOk('one byte over', { artifacts_produced: [{ type: 'brief', body: `${atCap}a` }] }),
      ).success,
    ).toBe(false)
  })
})

describe('skillFailure', () => {
  test('builds exactly one error carrying the code-derived retryability', () => {
    const built = skillFailure('auth_failure', 'TOKEN is not set')
    expect(built.status).toBe('failed')
    expect(built.errors).toHaveLength(1)

    const parsed = SkillResultSchema.parse(built)
    expect(parsed.errors[0]).toEqual({
      code: 'auth_failure',
      message: 'TOKEN is not set',
      impact: 'MEDIUM',
      retryable: false,
    })
  })

  test('retryability comes from the code and not from a hard-coded false', () => {
    // The discriminating case. A builder that wrote `retryable: false` itself
    // passes the test above and fails this one.
    const parsed = SkillResultSchema.parse(skillFailure('rate_limit', 'slow down'))
    expect(parsed.errors[0]?.retryable).toBe(true)
  })

  test('error overrides reach makeSkillError', () => {
    const parsed = SkillResultSchema.parse(
      skillFailure('timeout', 'took too long', { impact: 'HIGH', retryable: false }),
    )
    expect(parsed.errors[0]?.impact).toBe('HIGH')
    expect(parsed.errors[0]?.retryable).toBe(false)
  })

  test('result overrides and error overrides share one bag without colliding', () => {
    const parsed = SkillResultSchema.parse(
      skillFailure('data_missing', 'no rows', {
        phases_failed: ['collect'],
        source: 'upstream',
      }),
    )
    expect(parsed.phases_failed).toEqual(['collect'])
    expect(parsed.errors[0]?.source).toBe('upstream')
  })

  test('an empty message is not an error', () => {
    const parsed = SkillResultSchema.safeParse(skillFailure('parse_error', ''))
    expect(parsed.success).toBe(true)
  })
})

// ── The parse boundary, crossed for real ──────────────────────────────────

const MANIFEST: PluginManifest = {
  name: 'builder-plugin',
  version: '1.0.0',
  description: 'Fixture whose handler returns skillOk(...)',
  inputs: {},
  outputs: {},
  capabilities: [],
  schedule: 'on_run',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 5000,
  max_parallelism: 1,
  min_tier: 'normal',
  max_retries: 0,
  retry_delay_ms: 1,
}

let tmpDir: string
let eventsPath: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `warpline-result-builders-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  eventsPath = join(tmpDir, 'events.jsonl')
  const pluginDir = join(tmpDir, 'builder-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'manifest.ts'), `export const manifest = ${JSON.stringify(MANIFEST)}`)
  await writeFile(
    join(pluginDir, 'handler.ts'),
    [
      `import { skillOk } from ${JSON.stringify(BUILDER_PATH)}`,
      'export async function handler() {',
      "  return skillOk('built by the builder', {",
      "    phases_completed: ['collect'],",
      "    artifacts_produced: ['reports/one.md'],",
      '    reversible: true,',
      "    undo_instruction: 'delete reports/one.md',",
      '  })',
      '}',
    ].join('\n'),
  )
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('a handler that returns skillOk survives invokePlugin', () => {
  test('the fields the builder set reach the caller, and the ones it left alone are defaulted', async () => {
    const { result } = await invokePlugin('builder-plugin', {}, { pluginsDir: tmpDir, eventsPath })

    expect(result.status).toBe('success')
    expect(result.summary).toBe('built by the builder')
    expect(result.phases_completed).toEqual(['collect'])
    expect(result.reversible).toBe(true)
    expect(result.undo_instruction).toBe('delete reports/one.md')

    // Left to the schema by the builder, applied by the boundary. A builder
    // that restated `schema_version: 1` the way the runtime's own internal
    // literals do would show up right here.
    expect(result.schema_version).toBe(2)
    expect(result.errors).toEqual([])

    // The bare-string arm, normalized by the boundary and stamped by the
    // runtime. Reaching this shape from a handler is the thing the input
    // return type buys.
    expect(result.artifacts_produced).toHaveLength(1)
    expect(result.artifacts_produced[0]).toMatchObject({
      type: 'artifact',
      format: 'markdown',
      path: 'reports/one.md',
    })
    expect(result.artifacts_produced[0]?.run_id).toBeTruthy()
  })
})
