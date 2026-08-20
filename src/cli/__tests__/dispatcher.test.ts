/**
 * Dispatcher tests — in-process, no subprocess (D-27).
 *
 * `main()` returns a code and writes through process.stdout/stderr, so the
 * whole contract is assertable by swapping the two write functions. Plan
 * 02-08 budgets the repository to exactly ONE subprocess-launching test file
 * (the `warpline run` SIGINT case); do not spend it here.
 */
import { describe, test, expect } from 'bun:test'
import { main } from '../warpline.js'

const COMMANDS = ['plan', 'scaffold', 'run', 'approve', 'revoke'] as const

/** Run main(argv) with stdout/stderr captured, always restoring the originals. */
async function capture(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    const code = await main(argv)
    return { code, stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

describe('warpline dispatcher', () => {
  test('--help exits 0 and lists every command exactly once on stdout', async () => {
    const { code, stdout, stderr } = await capture(['--help'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    for (const cmd of COMMANDS) {
      const hits = stdout.match(new RegExp(`\\b${cmd}\\b`, 'g')) ?? []
      expect(hits).toHaveLength(1)
    }
  })

  test('-h and no argument print the same usage as --help', async () => {
    const help = await capture(['--help'])
    expect((await capture(['-h'])).stdout).toBe(help.stdout)
    expect((await capture([])).stdout).toBe(help.stdout)
  })

  test('an unknown command exits 1 and writes to stderr, not stdout', async () => {
    const { code, stdout, stderr } = await capture(['bogus'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('Unknown command: bogus')
    // The usage text goes to stderr too, so a user who mistypes still sees it.
    for (const cmd of COMMANDS) {
      expect(stderr).toContain(cmd)
    }
  })

  // `plan` was removed from this list when plan 02-05 replaced its stub body.
  // Plan 02-07 removes `approve` and `revoke` for the same reason, at which
  // point this test has nothing left to assert and should be deleted outright —
  // its real subject (each arm reaches its module) is covered by plan.test.ts
  // and approve.test.ts going through `main(argv)`.
  test('stub subcommands exit 1 on stderr behind the final signature', async () => {
    for (const cmd of ['approve', 'revoke']) {
      const { code, stdout, stderr } = await capture([cmd])
      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('not implemented in this build')
    }
  })
})
