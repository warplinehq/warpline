/**
 * `loadPluginConfig` — the disk half of the config channel.
 *
 * The one rule this file exists to pin: **missing is not invalid**. An absent
 * `<home>/config/<plugin>.json` is an empty config; a present-but-malformed one
 * is a hard failure. `readPreferences` returns defaults on BOTH, which is the
 * behaviour this loader deliberately refuses — silently defaulting a bad value
 * is how a plugin runs against the wrong target with a green board.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPluginConfig, PluginConfigError } from '../plugin-config.js'

let dir: string
let configPath: string

beforeEach(async () => {
  dir = join(tmpdir(), `warpline-plugin-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(dir, { recursive: true })
  configPath = join(dir, 'demo.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadPluginConfig', () => {
  test('an absent file is an empty config, not an error', async () => {
    await expect(loadPluginConfig(join(dir, 'nope.json'))).resolves.toEqual({})
  })

  test('a present-but-empty object is an empty config', async () => {
    await writeFile(configPath, '{}')
    await expect(loadPluginConfig(configPath)).resolves.toEqual({})
  })

  test('a well-formed config is returned as-is', async () => {
    await writeFile(configPath, JSON.stringify({ target: 'from-config', retention_days: 90 }))
    await expect(loadPluginConfig(configPath)).resolves.toEqual({
      target: 'from-config',
      retention_days: 90,
    })
  })

  test('unparseable JSON rejects with PluginConfigError naming the path', async () => {
    await writeFile(configPath, '{')
    const err = await loadPluginConfig(configPath).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PluginConfigError)
    expect((err as PluginConfigError).message).toContain(configPath)
    expect((err as PluginConfigError).configPath).toBe(configPath)
  })

  test('a schema violation rejects rather than falling back to defaults', async () => {
    await writeFile(configPath, JSON.stringify([1, 2, 3]))
    const err = await loadPluginConfig(configPath).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PluginConfigError)
    expect((err as PluginConfigError).message).toContain(configPath)
  })

  test('a key that is an Object.prototype member is refused, not merged', async () => {
    await writeFile(configPath, JSON.stringify({ toString: 'gotcha' }))
    await expect(loadPluginConfig(configPath)).rejects.toBeInstanceOf(PluginConfigError)
  })

  // The fixture is WELL FORMED on purpose. An unbalanced brace short circuits at
  // `JSON.parse` and returns a fixed string, so the assertion would pass without
  // ever reaching `describeIssues` — the arm that walks a `ZodError`, the arm
  // whose docstring justifies not forwarding `issue.message`, and the only one a
  // zod upgrade that starts quoting received values could silently change.
  test('the schema rejection message never echoes a config value', async () => {
    const secret = 'sk-live-do-not-echo-b52e7d'
    await writeFile(configPath, JSON.stringify({ toString: secret }))
    const err = await loadPluginConfig(configPath).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PluginConfigError)
    expect((err as PluginConfigError).message).not.toContain(secret)
  })

  // The other arm still needs its own assertion. `JSON.parse`'s SyntaxError
  // quotes the offending source text, and the offending source text is the
  // config file — forwarding it would leak exactly what the class above refuses
  // to. Covering one arm is not covering the other.
  test('the unparseable-JSON rejection message never echoes a config value', async () => {
    const secret = 'sk-live-do-not-echo-b52e7d'
    await writeFile(configPath, `{"target": "${secret}"`)
    const err = await loadPluginConfig(configPath).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PluginConfigError)
    expect((err as PluginConfigError).message).not.toContain(secret)
  })

  // Backstop for the phase's atomic-write truth: the loader never observes a
  // partially-written config, because a writer publishes via `.tmp`-then-
  // `rename` and `rename` is atomic within a filesystem. Mid-write, the final
  // path does not exist at all — which the loader reads as "absent", never as
  // "half a document".
  test('a torn read is unreachable across a .tmp-then-rename publish', async () => {
    const tmpPath = `${configPath}.tmp`
    await writeFile(tmpPath, '{"target": "from-conf')
    await expect(loadPluginConfig(configPath)).resolves.toEqual({})

    await writeFile(tmpPath, JSON.stringify({ target: 'from-config' }))
    await rename(tmpPath, configPath)
    await expect(loadPluginConfig(configPath)).resolves.toEqual({ target: 'from-config' })
  })
})
