/**
 * END-TO-END: the candidate example promotes only what an operator approved.
 *
 * The two real example directories, `candidate-propose` and
 * `candidate-promote`, run through the real `runAdvance`, and the approval is
 * given through the real `approve --content` verb. Fixture plugins cannot
 * stand in here: what this file proves is that the shipped manifests declare
 * the content class correctly and that the shipped handlers write where the
 * gate says they may.
 *
 * The negative half comes first and stands alone. With no content approval,
 * `candidate-promote` is skipped and the promoted file never appears, even
 * though `candidate-propose` ran and a proposal is sitting in state. An
 * advance that promoted here would mean the gate never saw the declaration.
 *
 * The positive half is exact. After `approve --content`, the promoted file
 * holds the three approved candidates, in proposal order, and nothing else.
 * Then the proposal moves under a live approval and the approval stops
 * applying: the refusal is `content_moved` and nothing is appended.
 *
 * Both home instances are re-rooted. The examples import `warpline/lib/paths`
 * through the package exports into `dist/`, while the engine and the approve
 * verb use `src/`. `_setHome` reaches only the second, so `WARPLINE_HOME` is
 * set for the first; without it the promoted file lands in the preload's home
 * and the assertions read the wrong directory.
 *
 * The two directories are symlinked, never copied: each manifest opens with a
 * `warpline/...` self-reference resolved from the file's real location.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, symlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runAdvance, type AdvanceOptions } from '../runtime/engine.js'
import { createTestHome, type TestHome } from '../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../lib/paths.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = ['candidate-propose', 'candidate-promote']

/** A wall clock far enough out that no test run reaches it. */
const FAR_FUTURE = '2099-01-01T00:00'

interface Candidate {
  id: string
  title: string
  score: number
}

let ctx: TestHome
let savedHome: string | undefined

beforeEach(async () => {
  ctx = await createTestHome()
  _setHome(ctx.root)
  savedHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = ctx.root
  for (const name of EXAMPLES) {
    symlinkSync(join(REPO_ROOT, 'examples', 'plugins', name), join(ctx.pluginsDir, name))
  }
})

afterEach(async () => {
  _setHome(null)
  if (savedHome === undefined) delete process.env.WARPLINE_HOME
  else process.env.WARPLINE_HOME = savedHome
  await ctx.cleanup()
})

function advance(options: Pick<AdvanceOptions, 'force'> = {}) {
  return runAdvance({
    pluginsDir: ctx.pluginsDir,
    // Full path to the state document, despite the option's name.
    stateDir: join(ctx.stateDir, 'engine-state.json'),
    runsDir: ctx.runsDir,
    eventsPath: join(ctx.stateDir, 'events.jsonl'),
    approvalPath: join(ctx.root, '.session-approval'),
    ...options,
  })
}

/** `warpline approve candidate-promote --content`, in-process, stdout captured. */
async function approveByContent(): Promise<string> {
  const realOut = process.stdout.write
  let stdout = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  try {
    const { run } = await import('../cli/approve.js')
    const code = await run(['candidate-promote', '--content', '--not-after', FAR_FUTURE])
    expect(code).toBe(0)
  } finally {
    process.stdout.write = realOut
  }
  return stdout
}

/** One candidate per score, `cand-<nn>` in the order given, at the default pool path. */
async function seedPool(scores: number[], prefix = 'cand'): Promise<Candidate[]> {
  const candidates = scores.map((score, i) => {
    const n = String(i + 1).padStart(2, '0')
    return { id: `${prefix}-${n}`, title: `Example candidate ${i + 1}`, score }
  })
  await writeFile(join(ctx.stateDir, 'candidates.json'), JSON.stringify({ candidates }))
  return candidates
}

async function proposedBody(): Promise<{ candidates: Candidate[] }> {
  const state = JSON.parse(await readFile(join(ctx.stateDir, 'engine-state.json'), 'utf-8')) as {
    plugin_runs: Record<string, { last_output?: { body?: string } }>
  }
  const body = state.plugin_runs['candidate-propose']?.last_output?.body
  expect(typeof body).toBe('string')
  return JSON.parse(body!) as { candidates: Candidate[] }
}

const promotedPath = () => join(ctx.root, 'state', 'promoted.json')

describe('the candidate example under runAdvance', () => {
  test('without a content approval candidate-promote is not due and promoted_path is unchanged', async () => {
    await seedPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const result = await advance()

    expect(result.plugin_states.get('candidate-propose')).toBe('completed')
    expect(result.plugin_states.get('candidate-promote')).toBe('skipped')
    expect(existsSync(promotedPath())).toBe(false)
    const proposal = await proposedBody()
    expect(proposal.candidates.map((c) => c.id)).toEqual(['cand-10', 'cand-09', 'cand-08'])
  })

  test('after approve --content exactly the approved candidates are appended', async () => {
    const pool = await seedPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await advance()
    const approved = (await proposedBody()).candidates

    await approveByContent()
    const result = await advance()

    expect(result.plugin_states.get('candidate-promote')).toBe('completed')
    const expected = [pool[9], pool[8], pool[7]]
    expect(approved).toEqual(expected as Candidate[])
    expect(JSON.parse(await readFile(promotedPath(), 'utf-8'))).toEqual({ promoted: expected })
  })
})
