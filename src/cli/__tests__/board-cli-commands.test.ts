/**
 * `board-cli`'s two descriptions of itself must both be complete.
 *
 * The file documents its commands twice — in the header docblock and in the
 * `default:` arm's help string — and implements them a third time, in the
 * router's `case` labels. Two hand-kept copies of one list is two copies that
 * drift: the docblock listed seven commands while the router implemented
 * eight, so the file's own documentation of itself was wrong and nothing said
 * so.
 *
 * Derived from the `case` labels, the way `dispatcher.test.ts` derives the
 * dispatcher's verbs. Source is read as text on purpose: `board-cli.ts` is a
 * script with top-level statements, so importing it would run it.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../board-cli.ts', import.meta.url)),
  'utf-8',
)

/**
 * Scoped to the COMMAND router. `board-cli.ts` holds other switches — event
 * type labels and run-ref kinds — whose `case` labels are not commands, so an
 * unscoped scan collects `task_created` and friends and asserts the docblock
 * should list them.
 */
const ROUTER = SOURCE.slice(SOURCE.indexOf('switch (cmd) {'))

const COMMANDS = [...ROUTER.matchAll(/^\s*case '([^']+)':/gm)]
  .map((m) => m[1] as string)
  .filter((label) => !label.startsWith('-'))

/** The header block comment, which is where a reader looks first. */
const DOCBLOCK = SOURCE.slice(0, SOURCE.indexOf('*/'))

/** The one-line command list the `default:` arm prints on an unknown command. */
const HELP_LINE =
  SOURCE.split('\n').find((l) => l.includes("console.log('Commands:")) ?? ''

describe('board-cli documents every command it implements', () => {
  test('the derivation finds the real command set', () => {
    // Vacuity guard: a regex that quietly stopped matching would make every
    // assertion below trivially true.
    expect(COMMANDS.length).toBeGreaterThanOrEqual(7)
    expect(COMMANDS).toContain('status')
    // Scoping is real, not incidental: a label from one of the file's other
    // switches must not be collected as a command.
    expect(COMMANDS).not.toContain('task_created')
    // The command the docblock omitted, pinned by name so the case that
    // prompted this test cannot come back unnoticed.
    expect(COMMANDS).toContain('auto-ack-poll')
    expect(HELP_LINE).not.toBe('')
  })

  test('the header docblock names every command', () => {
    for (const cmd of COMMANDS) expect(DOCBLOCK).toContain(cmd)
  })

  test("the default arm's help string names every command", () => {
    for (const cmd of COMMANDS) expect(HELP_LINE).toContain(cmd)
  })
})
