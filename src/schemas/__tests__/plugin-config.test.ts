/**
 * `resolvePluginArgs` — the precedence merge, one test per tier.
 *
 * The order is declared defaults, then the config file, then per-invocation
 * args. Args stay highest because that is what an operator typing a value on
 * the command line means by typing it, and because `warpline run` passes a
 * mandatory `action` positional no manifest declares.
 */
import { describe, expect, test } from 'bun:test'
import { resolvePluginArgs, PLUGIN_CONFIG_PRECEDENCE } from '../plugin-config.js'

const declared = {
  target: { type: 'string', required: false, default: 'from-default' },
}

function argsOf(result: ReturnType<typeof resolvePluginArgs>): Record<string, unknown> {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.args
}

describe('PLUGIN_CONFIG_PRECEDENCE', () => {
  test('documents the three tiers lowest-to-highest', () => {
    expect([...PLUGIN_CONFIG_PRECEDENCE]).toEqual([
      'manifest_default',
      'config_file',
      'invocation_args',
    ])
  })
})

describe('resolvePluginArgs precedence', () => {
  test('a key present only as a manifest default resolves to the default', () => {
    expect(argsOf(resolvePluginArgs(declared, {}, {}))['target']).toBe('from-default')
  })

  test('the config file outranks a manifest default', () => {
    expect(argsOf(resolvePluginArgs(declared, { target: 'from-config' }, {}))['target']).toBe(
      'from-config',
    )
  })

  test('per-invocation args outrank the config file', () => {
    expect(
      argsOf(resolvePluginArgs(declared, { target: 'from-config' }, { target: 'from-args' }))[
        'target'
      ],
    ).toBe('from-args')
  })

  test('a key present at all three levels resolves to the args value', () => {
    const args = argsOf(
      resolvePluginArgs(declared, { target: 'from-config' }, { target: 'from-args' }),
    )
    expect(args['target']).toBe('from-args')
  })

  test('a required input carrying a default succeeds against an empty config', () => {
    const result = resolvePluginArgs(
      { retention_days: { type: 'number', required: true, default: 90 } },
      {},
      {},
    )
    expect(result.ok).toBe(true)
    expect(argsOf(result)['retention_days']).toBe(90)
  })

  test('a required input with no default and no value anywhere is a problem', () => {
    const result = resolvePluginArgs({ repo: { type: 'string', required: true } }, {}, {})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain('repo')
  })

  test('a declared default does not mask a wrong type from the config file', () => {
    const result = resolvePluginArgs(
      { retention_days: { type: 'number', required: true, default: 90 } },
      { retention_days: 'ninety' },
      {},
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.problems[0]).toContain('number')
    expect(result.problems[0]).not.toContain('ninety')
  })

  test('an undeclared caller argument survives the merge', () => {
    expect(argsOf(resolvePluginArgs({}, {}, { action: 'refresh' }))['action']).toBe('refresh')
  })

  test('the merged object carries no prototype', () => {
    expect(Object.getPrototypeOf(argsOf(resolvePluginArgs({}, {}, {})))).toBeNull()
  })
})
