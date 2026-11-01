/**
 * The claude-code renderer's tool-less path, pinned at the module against a
 * fake `claude` reached by absolute path.
 *
 * The argv is `-p --bare --tools '' --output-format json --model <m>
 * --no-session-persistence --setting-sources '' --strict-mcp-config`, plus
 * `--max-budget-usd` only when a cap is set. The prompt goes on stdin and never
 * on argv. The child env is a literal allowlist, its HOME a fresh temp dir and
 * its cwd an empty temp dir, both removed after the call. Stdout is parsed
 * whatever the exit status, and an `api_error` result is read first.
 *
 * No case reaches a real provider. Every case hands the renderer an explicit
 * parent env and never `process.env`, which bun snapshots for its children.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
// The module this file pins before it exists, read through the namespace so
// each export is named where it is used.
import * as cc from '../claude-code.js'

const PROMPT = 'Summarise.\n\nline one\r\nnon-ascii é'
const SECRET = 'planted-secret-6f1c9e'
const PARENT_HOME = '/Users/operator-home'
const PARENT: Record<string, string> = {
  HOME: PARENT_HOME,
  PATH: '/opt/operator/bin:/usr/local/bin',
  SHELL: '/bin/zsh',
  ANTHROPIC_API_KEY: 'sk-test-passthrough',
  WARPLINE_TEST_SECRET: SECRET,
}

const OK_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'judgment text',
  total_cost_usd: 0.012345,
  modelUsage: { 'claude-opus-5': {} },
}

/** The locked passthrough list, written out here so the module cannot widen it unseen. */
const PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_VERTEX',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
]
const WARPLINE_SET = [
  'PATH',
  'HOME',
  'TERM',
  'CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK',
  'CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]
/** What bash adds to its own environment before `env` prints it. */
const SHELL_OWN = ['PWD', 'SHLVL', '_', 'OLDPWD']

const TOOLLESS_ARGV = [
  '-p',
  '--bare',
  '--tools',
  '',
  '--output-format',
  'json',
  '--model',
  'claude-opus-5',
  '--no-session-persistence',
  '--setting-sources',
  '',
  '--strict-mcp-config',
]

type Fake = { stdout: string; version?: string; sleepMs?: number; exitCode?: number }
type Call = Partial<Parameters<typeof cc.renderClaudeCode>[0]>

/** One render through the fake, with everything the fake saw read back after the call. */
async function render(fake: Fake, call: Call = {}) {
  const dump = await mkdtemp(join(tmpdir(), 'warpline-cc-dump-'))
  try {
    return await withFakeClaude({ ...fake, dumpDir: dump }, async () => {
      const bin = cc.resolveClaudeBin(process.env.PATH)
      if (bin === null) throw new Error('the fake claude was not found on PATH')
      const started = performance.now()
      const r = await cc.renderClaudeCode({
        bin,
        model: 'claude-opus-5',
        prompt: PROMPT,
        capMicro: null,
        parentEnv: PARENT,
        timeoutMs: 10_000,
        ...call,
      })
      const elapsed = performance.now() - started
      const read = (f: string): string | null => (existsSync(join(dump, f)) ? readFileSync(join(dump, f), 'utf8') : null)
      const env: Record<string, string> = {}
      for (const line of (read('env.txt') ?? '').split('\n').filter(Boolean)) {
        const at = line.indexOf('=')
        env[line.slice(0, at)] = line.slice(at + 1)
      }
      return {
        r,
        bin,
        elapsed,
        env,
        argv: read('argv.txt')?.split('\n').slice(0, -1) ?? null,
        cwdListing: read('cwd.txt'),
        pwd: read('pwd.txt')?.trim() ?? null,
        stdin: read('stdin.txt'),
        calls: (read('calls.txt') ?? '').split('\n').filter(Boolean).length,
      }
    })
  } finally {
    await rm(dump, { recursive: true, force: true })
  }
}

describe('one tool-less call', () => {
  test('tracer: a fake claude reached by absolute path returns one Judgment, its served model and its reported cost', async () => {
    const seen = await render({ stdout: JSON.stringify(OK_RESULT) })
    expect(seen.r).toEqual({
      ok: true,
      text: 'judgment text',
      served: 'claude-opus-5',
      cost_micro_usd: 12345,
      cost_basis: 'reported',
      reason: null,
    })
    expect(seen.calls).toBe(1)
    // Byte for byte, CR, blank line and non-ASCII included.
    expect(seen.stdin).toBe(PROMPT)
    // The fake listed its cwd before writing anything: the renderer handed it an empty dir.
    expect(seen.cwdListing).toBe('')
  })

  test('the argv is exactly the tool-less list, and the prompt is nowhere on it', async () => {
    const seen = await render({ stdout: JSON.stringify(OK_RESULT) })
    expect(seen.argv).toEqual(TOOLLESS_ARGV)
    for (const arg of seen.argv ?? []) {
      expect(arg.includes('Summarise')).toBe(false)
      expect(arg.includes('line one')).toBe(false)
    }
    for (const banned of [
      '--allowedTools',
      '--mcp-config',
      '--plugin-dir',
      '--settings',
      '--fallback-model',
      '--permission-mode',
      'bypassPermissions',
      '--add-dir',
      '--max-budget-usd',
    ]) {
      expect(seen.argv).not.toContain(banned)
    }
  })

  test('a per-call cap adds --max-budget-usd in USD with six decimals, and nothing else', async () => {
    const seen = await render({ stdout: JSON.stringify(OK_RESULT) }, { capMicro: 50_000 })
    expect(seen.argv).toEqual([...TOOLLESS_ARGV, '--max-budget-usd', '0.050000'])
  })
})

describe('the child env and its directories', () => {
  test('a planted secret is absent, and every child name is on the allowlist or the shell’s own', async () => {
    const seen = await render({ stdout: JSON.stringify(OK_RESULT) })
    expect(Object.keys(seen.env).length).toBeGreaterThan(0)
    expect(Object.values(seen.env)).not.toContain(SECRET)
    expect('WARPLINE_TEST_SECRET' in seen.env).toBe(false)
    expect('SHELL' in seen.env).toBe(false)
    const allowed = new Set([...WARPLINE_SET, ...PASSTHROUGH, ...SHELL_OWN])
    for (const name of Object.keys(seen.env)) expect([name, allowed.has(name)]).toEqual([name, true])
    // A passthrough name that is set crosses; one that is not set does not appear.
    expect(seen.env.ANTHROPIC_API_KEY).toBe('sk-test-passthrough')
    expect('ANTHROPIC_BASE_URL' in seen.env).toBe(false)
  })

  test('the warpline-set values: PATH leads with the binary’s dir, TERM is dumb, every fallback is off', async () => {
    const seen = await render({ stdout: JSON.stringify(OK_RESULT) })
    expect(seen.env.PATH).toBe(`${dirname(seen.bin)}:/usr/bin:/bin`)
    expect(seen.env.TERM).toBe('dumb')
    expect(seen.env.CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK).toBe('1')
    expect(seen.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK).toBe('1')
    expect(seen.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  })

  test('HOME is a fresh temp dir under /tmp that is neither the operator’s nor the cwd, and both are gone afterwards', async () => {
    const seen = await render({ stdout: JSON.stringify(OK_RESULT) })
    const home = seen.env.HOME
    expect(home).toBeDefined()
    expect(home).not.toBe(PARENT_HOME)
    expect(home!.startsWith('/tmp/')).toBe(true)
    expect(seen.pwd).not.toBeNull()
    expect(seen.pwd!.endsWith(`/tmp/${basename(seen.pwd!)}`)).toBe(true)
    expect(basename(home!)).not.toBe(basename(seen.pwd!))
    expect(existsSync(home!)).toBe(false)
    expect(existsSync(seen.pwd!)).toBe(false)
  })

  test('the module’s passthrough list is exactly the locked one', () => {
    expect<string[]>([...cc.CLAUDE_ENV_PASSTHROUGH]).toEqual(PASSTHROUGH)
  })
})

describe('reading the result', () => {
  test('an api_error is read first, whatever the subtype and the exit status, and is a failed render', async () => {
    const seen = await render({
      stdout: JSON.stringify({
        is_error: true,
        terminal_reason: 'api_error',
        subtype: 'success',
        total_cost_usd: 0,
        result: 'Not logged in',
      }),
      exitCode: 1,
    })
    expect(seen.r).toEqual({
      ok: false,
      text: null,
      served: null,
      cost_micro_usd: 0,
      cost_basis: 'reported',
      reason: 'the provider was not reachable',
    })
  })

  test('any other error flag is a failed render that keeps its reported cost', async () => {
    const seen = await render({
      stdout: JSON.stringify({ ...OK_RESULT, is_error: true, terminal_reason: 'max_turns', total_cost_usd: 0.5 }),
    })
    expect(seen.r).toMatchObject({
      ok: false,
      text: null,
      cost_micro_usd: 500_000,
      cost_basis: 'reported',
      reason: 'the renderer reported an error',
    })
  })

  test('a result with no total_cost_usd has an unknown cost', async () => {
    const { total_cost_usd: _, ...noCost } = OK_RESULT
    const seen = await render({ stdout: JSON.stringify(noCost) })
    expect(seen.r).toMatchObject({ ok: true, text: 'judgment text', cost_micro_usd: null, cost_basis: 'unknown' })
  })

  test('stdout that is not one JSON object is a failed render with an unknown cost', async () => {
    const seen = await render({ stdout: 'not json at all' })
    expect(seen.r).toEqual({
      ok: false,
      text: null,
      served: null,
      cost_micro_usd: null,
      cost_basis: 'unknown',
      reason: 'the renderer printed no result',
    })
  })

  test('a call past the timeout is killed and fails with its cost unknown, without waiting out the child', async () => {
    const seen = await render({ stdout: JSON.stringify(OK_RESULT), sleepMs: 5_000 }, { timeoutMs: 300 })
    expect(seen.r).toEqual({
      ok: false,
      text: null,
      served: null,
      cost_micro_usd: null,
      cost_basis: 'unknown',
      reason: 'the renderer did not answer in time',
    })
    expect(seen.elapsed).toBeLessThan(3_000)
    expect(existsSync(seen.pwd!)).toBe(false)
    expect(existsSync(seen.env.HOME!)).toBe(false)
  })
})

describe('the version floor', () => {
  test('CLAUDE_CLI_FLOOR is 2.1.305', () => {
    expect(cc.CLAUDE_CLI_FLOOR).toBe('2.1.305')
  })

  test.each([
    ['2.1.305 (Claude Code)', true],
    ['2.1.304 (Claude Code)', false],
    ['2.2.0', true],
    ['2.1.400', true],
    ['1.9.999', false],
    ['3.0.0', true],
    ['garbage', false],
    ['', false],
  ])('meetsFloor(%p) is %p', (text, expected) => {
    expect(cc.meetsFloor(text)).toBe(expected)
  })

  test('parseCliVersion reads the leading three numbers, and nothing else', () => {
    expect(cc.parseCliVersion('2.1.308 (Claude Code)')).toEqual([2, 1, 308])
    expect(cc.parseCliVersion('v2.1.308')).toBeNull()
    expect(cc.parseCliVersion('2.1')).toBeNull()
  })

  test('probeClaudeVersion returns the fake’s first stdout line', async () => {
    await withFakeClaude({ stdout: '', version: '2.1.305 (Claude Code)' }, async () => {
      const bin = cc.resolveClaudeBin(process.env.PATH)
      expect(bin).not.toBeNull()
      expect(await cc.probeClaudeVersion(bin!, PARENT)).toBe('2.1.305 (Claude Code)')
    })
  })
})

describe('the promoted helpers', () => {
  test('selectModelId picks the requested family’s key even when an auxiliary model is listed first', () => {
    const usage = { 'claude-haiku-4-5-20251001': { inputTokens: 912 }, 'claude-opus-5-20260101': { inputTokens: 14 } }
    expect(cc.selectModelId(usage, 'claude-opus-5')).toBe('claude-opus-5-20260101')
    expect(cc.selectModelId({ 'claude-haiku-4-5': {} }, 'claude-opus-5')).toBeNull()
    expect(cc.selectModelId(undefined, 'claude-opus-5')).toBeNull()
  })

  test('resolveClaudeBin finds the fake by absolute path on an explicit PATH, and null without it', async () => {
    await withFakeClaude({ stdout: '' }, async (dir) => {
      expect(cc.resolveClaudeBin(process.env.PATH)).toBe(join(dir, 'claude'))
    })
    const empty = await mkdtemp(join(tmpdir(), 'warpline-cc-empty-'))
    try {
      expect(cc.resolveClaudeBin(empty)).toBeNull()
      expect(cc.resolveClaudeBin(undefined)).toBeNull()
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
