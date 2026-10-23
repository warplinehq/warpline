/**
 * The shipped `needs-llm` scanner reads open Handoff records by the fields the
 * writer writes.
 *
 * The scanner ships as a Claude Code skill, outside `bun test`'s reach, so its
 * prose is the only form it has here. This file pins that the skill's
 * discovery steps read open Handoff records, by the field names `writeHandoff`
 * in `src/lib/handoffs.ts` actually writes, so the prose and the writer cannot
 * drift. The behaviour twin, the reader listing an advance's handoff, is
 * pinned in `src/runtime/__tests__/handoff-advance.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHandoff } from '../lib/handoffs.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const skill = () => readFileSync(join(REPO_ROOT, 'plugin/skills/needs-llm/SKILL.md'), 'utf-8')
// The skill's prose wraps at any word, so a sentence is matched with its whitespace collapsed.
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('the needs-llm scanner skill', () => {
  test('the scanner skill reads open Handoff records, by the fields the writer writes', async () => {
    const text = flat(skill())
    expect(text).toContain('handoffs/*.json')
    expect(text).toContain('"open"')
    // The whole sentence, so a step that keeps another state beside `open` is seen.
    expect(text).toContain('keep the ones whose `state` field is `"open"`.')
    expect(text).toContain('`superseded`')
    expect(text).toContain('nothing to do')
    expect(text).not.toContain('runs/*.json')

    const dir = mkdtempSync(join(tmpdir(), 'warpline-scanner-'))
    try {
      const handoffs = join(dir, 'handoffs')
      const written = await writeHandoff(handoffs, {
        run_id: 'run-1',
        plugin: 'prod',
        task: 't',
        context_path: 'state/x.json',
      })
      const record = JSON.parse(readFileSync(join(handoffs, `${written.id}.json`), 'utf-8')) as Record<string, unknown>
      for (const key of ['run_id', 'plugin', 'task', 'context_path', 'state']) {
        expect(Object.keys(record)).toContain(key)
        expect(text).toContain(`\`${key}\``)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the scanner skill keeps the in-home rule and its prohibition section', () => {
    const text = flat(skill())
    expect(text).toContain('Only paths resolving inside the warpline home may be read')
    expect(text).toContain('## What you must NOT do')
  })

  test("the scanner skill leaves consume's records to warpline consume", () => {
    const text = flat(skill())
    // The keep rule is step 2, from its open-state sentence to step 3.
    const start = text.indexOf('keep the ones whose `state` field is `"open"`.')
    const end = text.indexOf(' 3. ', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const keep = text.slice(start, end)
    expect(keep).toContain('`output_path`')
    expect(keep).toContain('.claim')
    expect(keep).toContain('`warpline consume`')
    expect(text).toContain('verbatim to the configured provider')
  })
})
