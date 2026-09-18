/**
 * Approved content is erased from the state document once no open window
 * names its run.
 *
 * **What it guards.** An operator's content approval binds a producer's Output
 * by `run_id`. That content is recipient data. While a window is open it has
 * to stay readable, because the consumer is still allowed to send it. Once the
 * last window naming the run has closed, nothing may keep it: the advance
 * erases `last_output.body` at its end-of-run write and leaves the record,
 * marked, behind.
 *
 * **Why the scan walks the whole home with no exclusion list.** The content
 * was never in the run log. It lived in `plugin_runs[producer].last_output` in
 * the state document, and a guard that looked only at the run log was green
 * over nothing. So this one reads every regular file under the home and asks
 * which of them still holds the content. Naming a file as "expected to hold
 * it" would turn the check back into a list of exceptions.
 *
 * **Why the sentinel is built at runtime.** The handler below is written into
 * the home as source. A literal sentinel would sit in that source file, and
 * the scan would find it there forever, red for a reason that has nothing to
 * do with the runtime. The handler builds the body by concatenation from an
 * environment variable, so the source never carries the value.
 *
 * **Why no consumer is installed.** The approval is keyed by a name with no
 * installed plugin, as `approval-retention.test.ts` does. A consumer would
 * read the content and could copy it into its own Outputs or summary, and then
 * the scan would be measuring the consumer. With none, nothing but
 * `last_output.body` ever holds the sentinel.
 *
 * Writes only inside its temp home. Nothing under the repository is touched.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'
import { snapshotHome } from './helpers/snapshot-home.js'

let h: TwoAdvanceHome
let sentinel: string

/**
 * The relative names of the files under `root` whose text contains `needle`,
 * sorted. Built on the one shared walk: a second recursive reader would be a
 * second place for an exclusion list to appear. Symlinks are recorded by the
 * walk and never followed, so they are skipped here.
 */
async function filesHolding(root: string, needle: string): Promise<string[]> {
  const kept: string[] = []
  for (const line of await snapshotHome(root)) {
    const [name, kind] = line.split('|')
    if (name === undefined || kind === 'link') continue
    const text = await readFile(join(root, name), 'utf-8')
    if (text.includes(needle)) kept.push(name)
  }
  return kept.sort()
}

beforeEach(async () => {
  h = await createTwoAdvanceHome()
  // The helper does not re-root the home. Without this, the run journal and
  // the dead-man file land outside the scan, and the scan cannot see them.
  _setHome(h.root)
  process.env.WARPLINE_ERASURE_SENTINEL = randomUUID()
  sentinel = 'approved-content:' + process.env.WARPLINE_ERASURE_SENTINEL

  await h.writePlugin('prod', {
    outputs: { brief: {} },
    handlerBody: `
import { existsSync } from 'node:fs'
export async function handler() {
  if (existsSync(${JSON.stringify(h.marker)})) {
    return {
      status: 'success',
      phases_completed: ['prod'],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: 'prod produced nothing',
      artifacts_produced: [],
      schema_version: 1,
    }
  }
  return {
    status: 'success',
    phases_completed: ['prod'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'prod produced',
    artifacts_produced: [
      { type: 'brief', format: 'text', body: 'approved-content:' + process.env.WARPLINE_ERASURE_SENTINEL },
    ],
    schema_version: 1,
  }
}
`,
  })
})

afterEach(async () => {
  _setHome(null)
  delete process.env.WARPLINE_ERASURE_SENTINEL
  await h.cleanup()
})

test('R8: once the last window naming a run closes, the approved content is nowhere under the home', async () => {
  await h.advance()
  // Non-vacuity: the fixture really put the content where the runtime holds
  // it, and nowhere else. Without this, an empty scan below proves nothing.
  expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])

  const prior = (await h.persistedRun('prod'))!.last_output as Record<string, unknown>
  expect(typeof prior.run_id).toBe('string')
  expect((prior.run_id as string).length).toBeGreaterThan(0)

  // One binding whose window closed long ago, naming the run that produced
  // the content. Keyed by a consumer that is not installed.
  const state = JSON.parse(await readFile(h.statePath, 'utf-8')) as Record<string, unknown>
  state.approvals = {
    ...((state.approvals as Record<string, unknown> | undefined) ?? {}),
    'batch-sender': {
      plugin: 'batch-sender',
      producer: 'prod',
      fingerprint: 'not-compared-here',
      run_id: prior.run_id,
      approved_at: '2026-08-29T11:00:00.000Z',
      not_before: null,
      not_after: '2000-01-02T00:00',
      zone: 'UTC',
      effect_id: null,
      marked_at: null,
      confirmed_at: null,
    },
  }
  await writeFile(h.statePath, JSON.stringify(state))

  await h.setMarker()
  await h.advance()

  // The assertion whose failure names the file still holding the content.
  expect(await filesHolding(h.root, sentinel)).toEqual([])

  const after = (await h.persistedRun('prod'))!.last_output as Record<string, unknown>
  expect('body' in after).toBe(false)
  expect(Number.isNaN(Date.parse(after.erased_at as string))).toBe(false)
  expect(after.body_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(after.body_sha256).toBe(createHash('sha256').update(sentinel).digest('hex'))
  expect(after.type).toBe(prior.type)
  expect(after.format).toBe(prior.format)
  expect(after.run_id).toBe(prior.run_id)
  expect(after.produced_at).toBe(prior.produced_at)
  const swept = JSON.parse(await readFile(h.statePath, 'utf-8')) as {
    approvals?: Record<string, unknown>
  }
  expect(swept.approvals?.['batch-sender']).toBeUndefined()

  // The next fail-closed read accepts the erased record, and erasing again
  // does not move the stamp.
  await h.advance()
  expect(await filesHolding(h.root, sentinel)).toEqual([])
  expect((await h.persistedRun('prod'))!.last_output).toEqual(after)
})
