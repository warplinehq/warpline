/**
 * `judgment_fed_effects` is a declaration only. An advance refuses a manifest
 * that sets it with no side effect, otherwise fires and skips exactly as it
 * would without it, and no runtime source names it.
 *
 * Every case builds its homes with `createTwoAdvanceHome`, so all writes land
 * in temp dirs (AGENTS.md Rule 2).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { grantApproval } from '../approval-gate.js'
import { createTwoAdvanceHome } from './helpers/two-advance-home.js'

const SUCCESS = `export async function handler() {
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'ran',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

/** The same success, after writing `path`, so a test can see the handler ran. */
function ranHandler(path: string): string {
  return `import { writeFileSync } from 'node:fs'
export async function handler() {
  writeFileSync(${JSON.stringify(path)}, 'ran')
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'ran',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`
}

afterEach(() => {
  _setHome(null)
})

describe('judgment_fed_effects', () => {
  test('an advance refuses at load a manifest declaring judgment_fed_effects with no side effect, naming the field', async () => {
    const home = await createTwoAdvanceHome()
    try {
      const ran = join(home.root, 'jfe-ran')
      await home.writePlugin('jfe', { judgmentFedEffects: true, handlerBody: ranHandler(ran) })

      const r = await home.advance()

      const entry = await home.entryFor(r.run_log_path, 'jfe')
      expect(entry?.status).toBe('failed')
      expect(entry?.result_summary).toContain("manifest field 'judgment_fed_effects' is not valid")
      expect(existsSync(ran)).toBe(false)
    } finally {
      await home.cleanup()
    }
  })

  test('the field changes nothing an advance fires or skips', async () => {
    for (const granted of [true, false]) {
      const a = await createTwoAdvanceHome()
      const b = await createTwoAdvanceHome()
      try {
        await a.writePlugin('mailer', {
          sideEffects: ['sends_email'],
          judgmentFedEffects: true,
          handlerBody: SUCCESS,
        })
        await b.writePlugin('mailer', { sideEffects: ['sends_email'], handlerBody: SUCCESS })
        if (granted) {
          for (const root of [a.root, b.root]) {
            _setHome(root)
            await grantApproval('mailer', 60 * 60_000, join(root, '.session-approval'))
          }
          _setHome(null)
        }

        const ra = await a.advance()
        const rb = await b.advance()

        const project = (path: string) =>
          (
            JSON.parse(readFileSync(path, 'utf-8')) as {
              plugin_entries: { plugin: string; status: string; result_summary: string }[]
            }
          ).plugin_entries.map(({ plugin, status, result_summary }) => ({ plugin, status, result_summary }))
        expect(project(ra.run_log_path)).toEqual(project(rb.run_log_path))
        expect(ra.gated_plugins).toEqual(rb.gated_plugins)
        expect((await a.persistedRun('mailer'))?.status).toBe((await b.persistedRun('mailer'))?.status)

        // Non-vacuity: the grant decides the fire in both homes alike.
        expect((await a.entryFor(ra.run_log_path, 'mailer'))?.status).toBe(granted ? 'completed' : 'skipped')
      } finally {
        await a.cleanup()
        await b.cleanup()
      }
    }
  })

  test('no runtime source file names the field', () => {
    const root = join(import.meta.dir, '..')
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
    // Could not look is never clean. The tree holds 13 today; the floor sits
    // under that so a new file never trips it, and over what a broken walk returns.
    if (files.length < 10 || !files.includes('engine.ts')) {
      throw new Error(`census found only ${files.length} runtime files under ${root}`)
    }
    const read = (f: string) => readFileSync(join(root, f), 'utf-8')
    // Positive control: the search can find a sibling field that the runtime does read.
    expect(files.some((f) => read(f).includes('llm_handoff'))).toBe(true)
    expect(files.filter((f) => read(f).includes('judgment_fed_effects'))).toEqual([])
  })
})
