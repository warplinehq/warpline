/**
 * END-TO-END: a plugin that declares an input receives it at invoke time.
 *
 * Every test here calls the real `invokePlugin` against a real fixture plugin
 * on disk with a real `<home>/config/<name>.json` beside it. That is the point:
 * `manifest.inputs` had zero readers before this phase, and a unit test of the
 * merge function would have passed the whole time it had none. The fixture
 * handlers BRANCH on the value they received rather than echoing it into a
 * `SkillResult` field — an assertion that reads the value back out of the
 * result would need the runtime to put it there, and a config file is where an
 * operator keeps an API token.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { invokePlugin } from '../invoke-plugin.js'
import { _setHome } from '../../lib/paths.js'

let root: string
let pluginsRoot: string
let configRoot: string
let eventsPath: string

interface FixtureInput {
  type: string
  required?: boolean
  default?: unknown
  description?: string
}

/** Write a fixture plugin whose handler succeeds only on the expected args. */
async function writePlugin(
  name: string,
  inputs: Record<string, FixtureInput>,
  handlerBody: string,
): Promise<void> {
  const dir = join(pluginsRoot, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: 'config channel fixture',
    inputs,
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
    max_retries: 3,
    retry_delay_ms: 1,
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `export async function handler(manifest, args) {
      const ok = (${handlerBody})(args)
      return {
        status: ok ? 'success' : 'failed',
        phases_completed: ok ? ['${name}'] : [],
        phases_failed: ok ? [] : ['${name}'],
        errors: ok ? [] : [{ code: 'data_missing', message: 'handler did not receive the expected args', impact: 'MEDIUM', retryable: false }],
        data_freshness: {},
        summary: '${name}: ' + (ok ? 'received what it declared' : 'wrong args'),
        artifacts_produced: [],
        schema_version: 1,
      }
    }`,
  )
}

async function writeConfig(name: string, body: string): Promise<string> {
  const p = join(configRoot, `${name}.json`)
  await writeFile(p, body)
  return p
}

function run(name: string, args: Record<string, unknown> = {}) {
  return invokePlugin(name, args, { pluginsDir: pluginsRoot, eventsPath }, { granted: false, reason: 'manual-run' })
}

beforeEach(async () => {
  root = join(tmpdir(), `warpline-invoke-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  pluginsRoot = join(root, 'plugins')
  configRoot = join(root, 'config')
  eventsPath = join(root, 'events.jsonl')
  await mkdir(pluginsRoot, { recursive: true })
  await mkdir(configRoot, { recursive: true })
  _setHome(root)
})

afterEach(async () => {
  _setHome(null)
  await rm(root, { recursive: true, force: true })
})

describe('invokePlugin config resolution', () => {
  test('a declared input reaches the handler from <home>/config/<plugin>.json', async () => {
    await writePlugin(
      'cfg-file',
      { target: { type: 'string', required: true } },
      `(a) => a.target === 'from-config'`,
    )
    await writeConfig('cfg-file', JSON.stringify({ target: 'from-config' }))

    const res = await run('cfg-file')
    expect(res.result.status).toBe('success')
  })

  test('per-invocation args outrank the config file', async () => {
    await writePlugin(
      'cfg-args-win',
      { target: { type: 'string', required: true } },
      `(a) => a.target === 'from-args'`,
    )
    await writeConfig('cfg-args-win', JSON.stringify({ target: 'from-config' }))

    const res = await run('cfg-args-win', { target: 'from-args' })
    expect(res.result.status).toBe('success')
  })

  test('a plugin declaring inputs: {} invoked with {} receives {}', async () => {
    await writePlugin('cfg-empty', {}, `(a) => Object.keys(a).length === 0`)

    const res = await run('cfg-empty')
    expect(res.result.status).toBe('success')
  })

  test('no config file and no required inputs resolves without error', async () => {
    await writePlugin(
      'cfg-absent',
      { since: { type: 'string', required: false } },
      `(a) => a.since === undefined`,
    )

    const res = await run('cfg-absent')
    expect(res.result.status).toBe('success')
  })

  test('an undeclared caller argument still reaches the handler', async () => {
    // `warpline run <plugin> <action>` passes a mandatory `action` positional
    // that no manifest declares. Resolution must MERGE over caller args, never
    // filter down to the declared set.
    await writePlugin('cfg-undeclared', {}, `(a) => a.action === 'refresh'`)

    const res = await run('cfg-undeclared', { action: 'refresh' })
    expect(res.result.status).toBe('success')
  })

  test('a required input with no value anywhere fails once as parse_error', async () => {
    await writePlugin(
      'cfg-missing',
      { target: { type: 'string', required: true } },
      `() => true`,
    )

    const res = await run('cfg-missing')
    expect(res.result.status).toBe('failed')
    expect(res.result.errors).toHaveLength(1)
    expect(res.result.errors?.[0]?.code).toBe('parse_error')
    expect(res.result.errors?.[0]?.retryable).toBe(false)
    expect(res.result.phases_failed).toEqual(['cfg-missing'])
    expect(res.attempt_count).toBe(1)
    expect(res.attempts).toHaveLength(1)
    expect(res.retried).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.timed_out).toBe(false)
  })

  test('the parse_error names the config path and the key but never the value', async () => {
    const secret = 'sk-live-never-print-me'
    await writePlugin(
      'cfg-mistyped',
      { retention_days: { type: 'number', required: true } },
      `() => true`,
    )
    const configPath = await writeConfig('cfg-mistyped', JSON.stringify({ retention_days: secret }))

    const res = await run('cfg-mistyped')
    const message = res.result.errors?.[0]?.message ?? ''
    expect(res.result.errors?.[0]?.code).toBe('parse_error')
    expect(message).toContain(configPath)
    expect(message).toContain('retention_days')
    expect(message).toContain('number')
    expect(message).not.toContain(secret)
  })

  test('a malformed config file fails once and never enters the retry loop', async () => {
    await writePlugin('cfg-malformed', {}, `() => true`)
    const configPath = await writeConfig('cfg-malformed', '{')

    const res = await run('cfg-malformed')
    expect(res.result.status).toBe('failed')
    expect(res.result.errors).toHaveLength(1)
    expect(res.result.errors?.[0]?.code).toBe('parse_error')
    expect(res.result.errors?.[0]?.retryable).toBe(false)
    // max_retries is 3 on the fixture — an attempt_count above 1 would mean the
    // failure arm landed inside the retry loop instead of above it.
    expect(res.attempt_count).toBe(1)
    expect(res.attempts).toHaveLength(1)
    expect(res.retried).toBe(false)
    expect(res.result.errors?.[0]?.message).toContain(configPath)
  })

  // ── The invalid-config failure matrix ────────────────────────────────
  //
  // Every case below asserts `attempt_count === 1` AND `attempts.length === 1`.
  // Those two numbers are the observable proof that the failure arm sits ABOVE
  // the retry loop rather than breaking out of it: the fixtures declare
  // `max_retries: 3`, so an implementation that entered the loop and broke on
  // a non-retryable error would still have recorded the attempt it made inside
  // it, and a second recorded attempt would be the tell.

  test('a present-but-wrong-typed value fails as parse_error and never reaches the handler', async () => {
    // The handler returns success unconditionally. A `failed` result therefore
    // proves the handler was not called, not merely that it disagreed.
    await writePlugin(
      'cfg-wrongtype',
      { retention_days: { type: 'number', required: true } },
      `() => true`,
    )
    // The STRING "90", not the number. A resolver that coerced would find a
    // perfectly good retention window here and the plugin would run against a
    // value its manifest says is not the type it declared.
    await writeConfig('cfg-wrongtype', JSON.stringify({ retention_days: '90' }))

    const res = await run('cfg-wrongtype')
    expect(res.result.status).toBe('failed')
    expect(res.result.errors).toHaveLength(1)
    expect(res.result.errors?.[0]?.code).toBe('parse_error')
    expect(res.result.errors?.[0]?.retryable).toBe(false)
    expect(res.result.phases_failed).toEqual(['cfg-wrongtype'])
    expect(res.attempt_count).toBe(1)
    expect(res.attempts).toHaveLength(1)
    expect(res.retried).toBe(false)
  })

  test('a declared default is not substituted for a present-but-invalid value', async () => {
    // The handler succeeds ONLY on the declared default. So if resolution had
    // fallen back to that default after rejecting the config file's value,
    // this run would be green — which is exactly the failure mode a fallback
    // produces: a plugin running happily against a number the operator never
    // asked for, on a board that says everything is fine.
    await writePlugin(
      'cfg-default-not-fallback',
      { retention_days: { type: 'number', required: false, default: 90 } },
      `(a) => a.retention_days === 90`,
    )
    await writeConfig('cfg-default-not-fallback', JSON.stringify({ retention_days: 'ninety' }))

    const res = await run('cfg-default-not-fallback')
    expect(res.result.status).toBe('failed')
    expect(res.result.errors).toHaveLength(1)
    expect(res.result.errors?.[0]?.code).toBe('parse_error')
    expect(res.result.errors?.[0]?.retryable).toBe(false)
    expect(res.attempt_count).toBe(1)
    expect(res.attempts).toHaveLength(1)
    expect(res.retried).toBe(false)
  })

  test('an absent config file with every input satisfiable is a success', async () => {
    // Absent is not malformed. Nothing here is wrong, so nothing here fails:
    // the optional input stays undefined and the declared default arrives.
    await writePlugin(
      'cfg-satisfiable',
      {
        since: { type: 'string', required: false },
        retention_days: { type: 'number', required: false, default: 90 },
      },
      `(a) => a.since === undefined && a.retention_days === 90`,
    )

    const res = await run('cfg-satisfiable')
    expect(res.result.status).toBe('success')
    expect(res.result.errors).toHaveLength(0)
  })

  test("a declared input named `action` loses to the CLI's mandatory positional", async () => {
    // `warpline run <plugin> <action>` passes `action` per invocation, and a
    // plugin is free to declare an input by that name. Per-invocation args are
    // the top precedence tier, so the operator's typed positional wins over
    // whatever the config file happens to hold for the same key.
    await writePlugin(
      'cfg-action-collision',
      { action: { type: 'string', required: true } },
      `(a) => a.action === 'from-cli'`,
    )
    await writeConfig('cfg-action-collision', JSON.stringify({ action: 'from-config' }))

    const res = await run('cfg-action-collision', { action: 'from-cli' })
    expect(res.result.status).toBe('success')
  })
})
