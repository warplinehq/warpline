/**
 * Dispatcher tests — in-process, no subprocess.
 *
 * `main()` returns a code and writes through process.stdout/stderr, so the
 * whole contract is assertable by swapping the two write functions. Plan
 * 02-08 budgets the repository to exactly ONE subprocess-launching test file
 * (the `warpline run` SIGINT case); do not spend it here.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main } from '../warpline.js'

const DISPATCHER_SOURCE = readFileSync(
  fileURLToPath(new URL('../warpline.ts', import.meta.url)),
  'utf-8',
)

/**
 * The verbs, read out of the dispatcher's own `case` labels rather than typed
 * here.
 *
 * A hand-kept list is a list that gets forgotten: this one said nothing about
 * `deny` for two plans, so the verb's USAGE line could have been deleted or
 * duplicated with the suite green. Deriving it means the next verb cannot be
 * forgotten either.
 *
 * The flag arms (`--help`, `-h`) share the switch and are not commands, so
 * they are dropped by their leading dash.
 */
const COMMANDS = [...DISPATCHER_SOURCE.matchAll(/^\s*case '([^']+)':/gm)]
  .map((m) => m[1] as string)
  .filter((label) => !label.startsWith('-'))

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
  // Vacuity guard: a regex that stopped matching would make every assertion
  // below pass over an empty list. Six verbs today, and this only has to say
  // the derivation found a real switch.
  test('the command list is derived from the dispatcher and is not empty', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(6)
    expect(COMMANDS).toContain('deny')
  })

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
})

describe('dispatcher error routing', () => {
  /**
   * `main()` catches `EngineStateInvalidError` and turns it into a message and
   * code 1. That catch only sees a rejection it awaited: inside a `try`, a
   * bare `return somePromise` adopts the promise after the try scope has
   * exited, so the rejection escapes unhandled, with a stack — the exact
   * opposite of the contract.
   *
   * This reads the source rather than exercising it because no dispatcher arm
   * reaches the write-capable engine-state read yet. Nothing behavioural goes
   * red when the `await` is dropped, which is precisely why the guard has to
   * be structural.
   */
  test('every dynamically imported subcommand is returned with await, so the catch can see its rejection', () => {
    const source = DISPATCHER_SOURCE

    const imported = new Set(
      [...source.matchAll(/const\s*\{([^}]+)\}\s*=\s*await import\(/g)].flatMap((m) =>
        (m[1] as string).split(',').map((name) => name.trim()),
      ),
    )
    // Guards the regex itself: an empty set would make the assertion vacuous.
    expect(imported.size).toBeGreaterThan(0)

    const unawaited = [...source.matchAll(/return\s+([A-Za-z_$][\w$]*)\(/g)]
      .map((m) => m[1] as string)
      .filter((name) => imported.has(name))

    expect(unawaited).toEqual([])
  })
})
