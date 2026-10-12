/**
 * The `notify` runner: argv with no shell, the message on stdin, a timeout that
 * kills the command's whole process group, and an environment built from an
 * allowlist.
 *
 * Every stub is a `/bin/sh` script under a per-case temp dir, written by
 * `test-utils/notify-stub.ts` (AGENTS.md Rule 2). A hang stub sleeps for a
 * number of seconds unique to the case, so `pgrep -f "sleep <marker>"` sees only
 * its own processes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOTIFY_ENV_KEYS, notifyEnv, runNotify } from '../notify.js'
import * as preferences from '../preferences.js'
import { _setHome } from '../paths.js'
import { main } from '../../cli/warpline.js'
import { notifyStub } from '../../../test-utils/notify-stub.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warpline-notify-'))
})

afterEach(async () => {
  _setHome(null)
  await rm(dir, { recursive: true, force: true })
})

/**
 * `pgrep -f "sleep <marker>"`'s exit status once it stops matching, or after
 * two seconds. A killed process can stay visible for a moment while it is
 * reaped; one that was never killed sleeps for 50 seconds or more, so the wait
 * cannot hide a survivor.
 */
async function pgrepStatus(marker: string): Promise<number | null> {
  const deadline = Date.now() + 2000
  for (;;) {
    const { status } = spawnSync('/usr/bin/pgrep', ['-f', `sleep ${marker}`])
    if (status !== 0 || Date.now() > deadline) return status
    await Bun.sleep(50)
  }
}

describe('the notify runner', () => {
  test('delivers one payload on stdin to argv with no shell', async () => {
    const injected = `$(touch ${dir}/pwned)`
    const stub = await notifyStub(dir, 'ok', { extraArgs: [injected, 'two words'] })

    const result = await runNotify(stub.argv, '{"entries":[]}', 5000, notifyEnv({ PATH: process.env.PATH }))

    expect(result).toEqual({ outcome: 'delivered', exit_code: 0 })
    expect(stub.messages()).toEqual([{ entries: [] }])
    expect(stub.args()[0]).toEqual([injected, 'two words'])
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
  })

  test('a non-zero exit is failed with its code', async () => {
    const stub = await notifyStub(dir, 'fail', { exitCode: 3 })

    expect(await runNotify(stub.argv, '{}', 5000, notifyEnv({ PATH: process.env.PATH }))).toEqual({
      outcome: 'failed',
      exit_code: 3,
    })
  })

  test('a missing command is failed with no code, before its timeout', async () => {
    const started = Date.now()

    const result = await runNotify([join(dir, 'nope')], '{}', 5000, notifyEnv({ PATH: process.env.PATH }))

    expect(result).toEqual({ outcome: 'failed', exit_code: null })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('a hang is killed with its whole group at the timeout', async () => {
    const stub = await notifyStub(dir, 'hang', { grandchild: true })
    const started = Date.now()

    const result = await runNotify(stub.argv, '{}', 500, notifyEnv({ PATH: process.env.PATH }))
    const elapsed = Date.now() - started

    expect(result).toEqual({ outcome: 'timeout', exit_code: null })
    expect(elapsed).toBeGreaterThanOrEqual(450)
    expect(elapsed).toBeLessThan(3000)
    expect(existsSync(stub.startedPath)).toBe(true)
    expect(await pgrepStatus(stub.marker)).toBe(1)
  })

  test('a command that exits without reading a large payload does not crash the caller', async () => {
    const script = join(dir, 'early-exit.sh')
    await writeFile(script, '#!/bin/sh\nexit 0\n')
    await chmod(script, 0o755)

    const result = await runNotify([script], 'x'.repeat(1 << 20), 5000, notifyEnv({ PATH: process.env.PATH }))

    expect(result).toEqual({ outcome: 'delivered', exit_code: 0 })
  })

  test('the child sees the allowlist and nothing else', async () => {
    // Planted in this process too, so a runner that hands down its own
    // environment shows the secret whatever the outer shell carried.
    process.env.WARPLINE_TEST_SECRET = 'leak'
    try {
      const env = notifyEnv({
        PATH: process.env.PATH,
        HOME: dir,
        HTTPS_PROXY: 'http://proxy.invalid',
        WARPLINE_TEST_SECRET: 'leak',
        USER: 'acct',
        LOGNAME: 'acct',
      })
      expect(Object.keys(env).sort()).toEqual(['HOME', 'HTTPS_PROXY', 'PATH'])
      expect(Object.keys(env).every((k) => (NOTIFY_ENV_KEYS as readonly string[]).includes(k))).toBe(true)

      const stub = await notifyStub(dir, 'ok')
      expect(await runNotify(stub.argv, '{}', 5000, env)).toEqual({ outcome: 'delivered', exit_code: 0 })

      const seen = stub.envs()[0]!
      expect(seen.HTTPS_PROXY).toBe('http://proxy.invalid')
      expect(seen.PATH).toBe(process.env.PATH!)
      const names = Object.keys(seen)
      expect(names).not.toContain('WARPLINE_TEST_SECRET')
      expect(names).not.toContain('USER')
      expect(names).not.toContain('LOGNAME')
    } finally {
      delete process.env.WARPLINE_TEST_SECRET
    }
  })

  test('a process that exits while its notify hangs takes the group down', async () => {
    const stub = await notifyStub(dir, 'hang', { grandchild: true })
    const runner = join(dir, 'exits-mid-notify.ts')
    const notifyModule = join(import.meta.dir, '..', 'notify.ts')
    await writeFile(
      runner,
      [
        `import { existsSync } from 'node:fs'`,
        `import { notifyEnv, runNotify } from ${JSON.stringify(notifyModule)}`,
        `void runNotify(${JSON.stringify(stub.argv)}, '{}', 60000, notifyEnv({ PATH: process.env.PATH }))`,
        `const deadline = Date.now() + 10000`,
        `while (!existsSync(${JSON.stringify(stub.startedPath)})) {`,
        `  if (Date.now() > deadline) process.exit(2)`,
        `  await Bun.sleep(20)`,
        `}`,
        `process.exit(0)`,
        '',
      ].join('\n'),
    )

    // An explicit env: bun's child env is a startup snapshot.
    const ran = spawnSync(process.execPath, [runner], { env: { PATH: process.env.PATH ?? '', HOME: dir } })

    expect(ran.status).toBe(0)
    expect(await pgrepStatus(stub.marker)).toBe(1)
  })

  test('the setting an operator sets is the command that receives the message', async () => {
    const home = join(dir, 'home')
    _setHome(home)
    const stub = await notifyStub(dir, 'ok')

    expect(await main(['prefs', 'set', 'notify', JSON.stringify({ argv: stub.argv })])).toBe(0)

    const parsed = preferences.parseNotify((await preferences.readPreferences(join(home, 'preferences.json'))).notify)
    expect(parsed).toEqual({
      notify: { argv: stub.argv, timeout_ms: 10000, include_content: false, reminders_ms: [3600000, 14400000] },
    })
    if (!('notify' in parsed) || parsed.notify === null) throw new Error('notify did not parse')

    const payload = { entries: [{ id: 'a1', event: 'raised' }] }
    const result = await runNotify(
      parsed.notify.argv,
      JSON.stringify(payload),
      parsed.notify.timeout_ms,
      notifyEnv({ PATH: process.env.PATH }),
    )

    expect(result).toEqual({ outcome: 'delivered', exit_code: 0 })
    expect(stub.messages()).toEqual([payload])
  })
})
