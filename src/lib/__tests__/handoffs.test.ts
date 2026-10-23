/**
 * The Handoff record, pinned at the module.
 *
 * A `[needs-llm]` handoff becomes one record file named by its run and its
 * plugin. Its task and context path come from the result: the structured
 * field when there is one, the summary otherwise, and the path is copied raw.
 * The new record is written before any older open record of the same plugin
 * is superseded, so a plugin never ends with zero open records. The writer
 * refuses an id that is not a file name. The reader lists open records, and a
 * file it cannot read is named, never read as "no records".
 *
 * Every case gets its own temp dir, and the records directory inside it is
 * left for the writer to create (AGENTS.md Rule 2). The clock is fixed and
 * handed in.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NeedsLlmSchema, type SkillResult } from '../../schemas/skill-result.js'
// The module this file pins before it exists, read through the namespace so
// each export is named where it is used.
import * as lib from '../handoffs.js'

const T0 = Date.parse('2026-10-14T08:00:00.000Z')

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'warpline-handoffs-'))
  dir = join(root, 'handoffs')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function raw(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>
}

function bytes(name: string): string {
  return readFileSync(join(dir, name), 'utf-8')
}

function result(summary: string, needsLlm?: { task: string; context_path: string; output_path?: string }): SkillResult {
  return {
    status: 'skipped',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary,
    artifacts_produced: [],
    schema_version: 1,
    ...(needsLlm === undefined ? {} : { needs_llm: needsLlm }),
  }
}

/** A well-formed open record, written by hand. */
function openRecord(runId: string, plugin: string, at: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    min_reader_version: 1,
    id: `${runId}.${plugin}`,
    run_id: runId,
    plugin,
    task: 't',
    context_path: null,
    created_at: new Date(at).toISOString(),
    state: 'open',
    closed_at: null,
    ...extra,
  }
}

function write(runId: string, plugin: string, at: number): ReturnType<typeof lib.writeHandoff> {
  return lib.writeHandoff(dir, { run_id: runId, plugin, task: 't', context_path: null }, at)
}

async function openIds(path: string = dir): Promise<string[]> {
  return (await lib.readOpenHandoffs(path)).open.map((h) => h.id)
}

describe('a handoff becomes one open record the reader finds', () => {
  test('a written handoff is one open record, named by its run and plugin, that the reader lists', async () => {
    await lib.writeHandoff(dir, { run_id: 'run-1', plugin: 'prod', task: 'Summarise the brief', context_path: 'state/brief.json' }, T0)

    expect(readdirSync(dir)).toEqual(['run-1.prod.json'])
    const expected: lib.Handoff = {
      min_reader_version: 1,
      id: 'run-1.prod',
      run_id: 'run-1',
      plugin: 'prod',
      task: 'Summarise the brief',
      context_path: 'state/brief.json',
      output_path: null,
      tries: [],
      created_at: new Date(T0).toISOString(),
      state: 'open',
      closed_at: null,
    }
    expect(raw('run-1.prod.json')).toEqual(expected)
    expect(await lib.readOpenHandoffs(dir)).toEqual({ open: [expected], unreadable: [] })
  })
})

describe('the record takes its task and context path from the result', () => {
  test('the structured field wins over the summary', () => {
    const fields = lib.handoffFields(
      'run-1',
      'prod',
      result('[needs-llm] Summarise the brief. Context: /elsewhere/brief.json', {
        task: 'Summarise the brief',
        context_path: 'state/brief.json',
      }),
    )
    expect(fields).toEqual({ run_id: 'run-1', plugin: 'prod', task: 'Summarise the brief', context_path: 'state/brief.json', output_path: null })
  })

  test('a prefix-only summary gives its task and its Context: path, raw', () => {
    const fields = lib.handoffFields('run-1', 'prod', result('[needs-llm] Triage 2 new feed entries. Context: /tmp/payload.json'))
    expect(fields).toEqual({ run_id: 'run-1', plugin: 'prod', task: 'Triage 2 new feed entries', context_path: '/tmp/payload.json', output_path: null })
  })

  test('a prefix-only summary with no Context: gives the whole remainder and a null path', () => {
    const fields = lib.handoffFields('run-1', 'prod', result('[needs-llm] summarise the brief'))
    expect(fields).toEqual({ run_id: 'run-1', plugin: 'prod', task: 'summarise the brief', context_path: null, output_path: null })
  })
})

describe('the record carries where its Judgment goes', () => {
  test('a write with an output path carries it', async () => {
    await lib.writeHandoff(dir, { run_id: 'run-1', plugin: 'prod', task: 't', context_path: null, output_path: 'state/x.md' }, T0)
    expect(raw('run-1.prod.json').output_path).toBe('state/x.md')
    expect(raw('run-1.prod.json').tries).toEqual([])
  })

  test('handoffFields copies needs_llm.output_path, and gives null without it', () => {
    const withPath = lib.handoffFields(
      'run-1',
      'prod',
      result('[needs-llm] Draft. Context: state/brief.json', { task: 'Draft', context_path: 'state/brief.json', output_path: 'state/x.md' }),
    )
    expect(withPath.output_path).toBe('state/x.md')
    const without = lib.handoffFields('run-1', 'prod', result('[needs-llm] Draft', { task: 'Draft', context_path: 'state/brief.json' }))
    expect(without.output_path).toBeNull()
  })

  test('a record written before output_path and tries existed still reads as open', async () => {
    mkdirSync(dir)
    writeFileSync(join(dir, 'run-1.prod.json'), JSON.stringify(openRecord('run-1', 'prod', T0), null, 2))
    expect(await openIds()).toEqual(['run-1.prod'])
  })

  test('needs_llm.output_path outside judgments/ is refused by name, never by value', () => {
    const parse = (output_path: string) => NeedsLlmSchema.safeParse({ task: 't', context_path: 'state/a.json', output_path })
    const messageOf = (output_path: string) => {
      const parsed = parse(output_path)
      expect(parsed.success).toBe(false)
      return parsed.error!.issues.map((i) => i.message).join('\n')
    }
    expect(NeedsLlmSchema.parse({ task: 't', context_path: 'state/a.json', output_path: 'judgments/x.md' }).output_path).toBe('judgments/x.md')
    const refused = [
      'state/x.md',
      '.session-approval',
      'preferences.json',
      'handoffs/x.json',
      'plugins/p/handler.ts',
      'judgments-evil/x.md',
      'judgments/../x.md',
      '../x',
      '/abs/x',
      'C:\\x',
    ]
    for (const bad of refused) {
      const message = messageOf(bad)
      expect(message).toContain('needs_llm.output_path')
      expect(message).not.toContain(bad)
    }
    // The directory itself is not a file under it. Its name is part of the fixed message, so there is no never-by-value check here.
    for (const bad of ['judgments', 'judgments/']) expect(messageOf(bad)).toContain('needs_llm.output_path')
  })
})

describe('supersede', () => {
  test('a first handoff for a plugin supersedes nothing', async () => {
    await write('run-1', 'prod', T0)

    expect(readdirSync(dir)).toEqual(['run-1.prod.json'])
    expect(raw('run-1.prod.json').state).toBe('open')
    expect(raw('run-1.prod.json').closed_at).toBeNull()
  })

  test("a second handoff supersedes the first, and another plugin's record is untouched", async () => {
    await write('run-0', 'other', T0)
    await write('run-1', 'prod', T0 + 1000)
    const otherBefore = bytes('run-0.other.json')
    await write('run-2', 'prod', T0 + 2000)

    const first = raw('run-1.prod.json')
    const second = raw('run-2.prod.json')
    expect(first.state).toBe('superseded')
    expect(first.closed_at).toBe(second.created_at as string)
    expect(second.state).toBe('open')
    expect(second.closed_at).toBeNull()
    expect(bytes('run-0.other.json')).toBe(otherBefore)
    expect(await openIds()).toEqual(['run-0.other', 'run-2.prod'])
  })

  test('two handoffs in the same millisecond still order, and the newer stays open', async () => {
    await write('run-1', 'prod', T0)
    await write('run-2', 'prod', T0)

    expect(raw('run-2.prod.json').created_at).toBe(new Date(T0 + 1).toISOString())
    expect(raw('run-1.prod.json').state).toBe('superseded')
    expect(raw('run-2.prod.json').state).toBe('open')
  })

  test('a write that fails supersedes nothing, so the plugin never ends with zero open records', async () => {
    await write('run-1', 'prod', T0)
    // A directory where the new file must go, so its rename fails.
    mkdirSync(join(dir, 'run-2.prod.json'))

    await expect(lib.writeHandoff(dir, { run_id: 'run-2', plugin: 'prod', task: 't', context_path: null }, T0 + 1000)).rejects.toThrow()
    expect(raw('run-1.prod.json').state).toBe('open')
  })

  test('racing writers never supersede the newest, and the next handoff reconciles them', async () => {
    await Promise.all([write('run-a', 'prod', T0), write('run-b', 'prod', T0)])

    const records = readdirSync(dir)
      .filter((n) => n.endsWith('.prod.json'))
      .map((n) => raw(n))
    expect(records.length).toBe(2)
    const newest = [...records].sort((a, b) => {
      const ta = Date.parse(a.created_at as string)
      const tb = Date.parse(b.created_at as string)
      if (ta !== tb) return tb - ta
      return (a.id as string) < (b.id as string) ? 1 : -1
    })[0]!
    expect(newest.state).toBe('open')
    expect(records.some((r) => r.state === 'open')).toBe(true)

    await write('run-c', 'prod', T0 + 5000)
    expect(await openIds()).toEqual(['run-c.prod'])
    expect(raw('run-a.prod.json').state).toBe('superseded')
    expect(raw('run-b.prod.json').state).toBe('superseded')
  })

  test('a record from a newer reader, or one that does not parse, is never rewritten', async () => {
    mkdirSync(dir)
    writeFileSync(join(dir, 'run-0.prod.json'), JSON.stringify(openRecord('run-0', 'prod', T0 - 1000, { min_reader_version: 2 }), null, 2))
    writeFileSync(join(dir, 'run-00.prod.json'), '{')
    const newerBefore = bytes('run-0.prod.json')
    const brokenBefore = bytes('run-00.prod.json')

    await write('run-1', 'prod', T0)

    expect(bytes('run-0.prod.json')).toBe(newerBefore)
    expect(bytes('run-00.prod.json')).toBe(brokenBefore)
    const read = await lib.readOpenHandoffs(dir)
    expect(read.open.map((h) => h.id)).toEqual(['run-1.prod'])
    expect(read.unreadable).toEqual(['run-0.prod.json', 'run-00.prod.json'])
  })

  test('a superseded record never returns to open', async () => {
    await write('run-1', 'prod', T0)
    await write('run-2', 'prod', T0 + 1000)
    const afterSecond = bytes('run-1.prod.json')
    await write('run-3', 'prod', T0 + 2000)

    expect(bytes('run-1.prod.json')).toBe(afterSecond)
    expect(raw('run-1.prod.json').state).toBe('superseded')
  })
})

describe('the writer refuses an id that is not a file name', () => {
  test('a run id or plugin name outside its rule is refused, and nothing is written', async () => {
    const cases: Array<[string, string]> = [
      ...['../x', 'a/b', 'a.b', ''].map((runId): [string, string] => [runId, 'prod']),
      ...['../x', 'Prod', 'a.b'].map((plugin): [string, string] => ['run-1', plugin]),
    ]
    for (const [runId, plugin] of cases) {
      const err = await lib.writeHandoff(dir, { run_id: runId, plugin, task: 't', context_path: null }, T0).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect((err as NodeJS.ErrnoException).code).toBe('EINVAL')
    }
    expect(existsSync(dir)).toBe(false)
  })
})

describe('the reader', () => {
  test('a missing directory reads as no open records', async () => {
    expect(await lib.readOpenHandoffs(join(root, 'nope'))).toEqual({ open: [], unreadable: [] })
  })

  test('a superseded record is not listed, a temp file is ignored, and an unreadable record is named', async () => {
    await write('run-1', 'prod', T0)
    await write('run-2', 'prod', T0 + 1000)
    writeFileSync(join(dir, 'run-9.prod.json.tmp-1-abc'), '{')
    writeFileSync(join(dir, 'run-8.prod.json'), '{')
    writeFileSync(join(dir, 'wrong.prod.json'), JSON.stringify(openRecord('run-7', 'prod', T0 + 2000), null, 2))

    const read = await lib.readOpenHandoffs(dir)
    expect(read.open.map((h) => h.id)).toEqual(['run-2.prod'])
    expect(read.unreadable).toEqual(['run-8.prod.json', 'wrong.prod.json'])
  })

  test('a directory the reader cannot list is not read as empty', async () => {
    writeFileSync(dir, 'not a directory')
    await expect(lib.readOpenHandoffs(dir)).rejects.toThrow()
  })
})

describe('a state this build never writes is closed', () => {
  // `consumed` stands for a state a later build may add, and a reader acts only on `open`.
  function writeConsumed(): string {
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'run-1.prod.json'),
      JSON.stringify(
        openRecord('run-1', 'prod', T0 + 5000, { state: 'consumed', closed_at: new Date(T0 + 6000).toISOString() }),
        null,
        2,
      ),
    )
    return bytes('run-1.prod.json')
  }

  test('a record in a state this build never writes is neither open nor unreadable', async () => {
    writeConsumed()
    expect(await lib.readOpenHandoffs(dir)).toEqual({ open: [], unreadable: [] })
  })

  test('withdrawing a record in a state this build never writes returns false and leaves it as it is', async () => {
    const before = writeConsumed()
    expect(await lib.withdrawHandoff(dir, 'run-1', 'prod', new Date(T0 + 7000).toISOString())).toBe(false)
    expect(bytes('run-1.prod.json')).toBe(before)
  })

  test('a record in a state this build never writes still holds the clock floor, and is never superseded', async () => {
    const before = writeConsumed()
    const rec = await write('run-2', 'prod', T0)
    expect(rec.created_at).toBe(new Date(T0 + 5001).toISOString())
    expect(bytes('run-1.prod.json')).toBe(before)
    expect((await lib.readOpenHandoffs(dir)).open.map((h) => h.id)).toEqual(['run-2.prod'])
  })
})

describe('the edge of the open-world state', () => {
  // Any string is a state, '' included. A missing or non-string state is not a record.
  function writeRecord(record: Record<string, unknown>): string {
    mkdirSync(dir)
    writeFileSync(join(dir, 'run-1.prod.json'), JSON.stringify(record, null, 2))
    return bytes('run-1.prod.json')
  }
  const closedAt = new Date(T0 + 7000).toISOString()

  test('a record with no state is unreadable, not open, and withdrawing it throws EINVAL and leaves it as it is', async () => {
    const rec = openRecord('run-1', 'prod', T0)
    delete rec.state
    const before = writeRecord(rec)
    expect(await lib.readOpenHandoffs(dir)).toEqual({ open: [], unreadable: ['run-1.prod.json'] })
    const err = await lib.withdrawHandoff(dir, 'run-1', 'prod', closedAt).then(() => null, (e: unknown) => e)
    expect((err as NodeJS.ErrnoException | null)?.code).toBe('EINVAL')
    expect(bytes('run-1.prod.json')).toBe(before)
  })

  for (const state of [42, null]) {
    test(`a record whose state is ${state} is unreadable, and withdrawing it throws EINVAL and leaves it as it is`, async () => {
      const before = writeRecord(openRecord('run-1', 'prod', T0, { state }))
      expect(await lib.readOpenHandoffs(dir)).toEqual({ open: [], unreadable: ['run-1.prod.json'] })
      const err = await lib.withdrawHandoff(dir, 'run-1', 'prod', closedAt).then(() => null, (e: unknown) => e)
      expect((err as NodeJS.ErrnoException | null)?.code).toBe('EINVAL')
      expect(bytes('run-1.prod.json')).toBe(before)
    })
  }

  test('a record whose state is the empty string reads as closed, and withdrawing it returns false and leaves it as it is', async () => {
    const before = writeRecord(openRecord('run-1', 'prod', T0, { state: '' }))
    expect(await lib.readOpenHandoffs(dir)).toEqual({ open: [], unreadable: [] })
    expect(await lib.withdrawHandoff(dir, 'run-1', 'prod', closedAt)).toBe(false)
    expect(bytes('run-1.prod.json')).toBe(before)
  })
})

describe('a record that cannot be written', () => {
  test('handoffNotRecorded is a fixed failed result naming the act, with the errno code and no path', () => {
    const failed = lib.handoffNotRecorded(
      'prod',
      Object.assign(new Error('ENOTDIR: not a directory, scandir /secret/home/handoffs'), { code: 'ENOTDIR' }),
    )
    expect(failed).toEqual({
      status: 'failed',
      phases_completed: [],
      phases_failed: ['prod'],
      errors: [expect.objectContaining({ code: 'dependency_unavailable', retryable: false })],
      data_freshness: {},
      summary: 'prod: handoff not recorded',
      artifacts_produced: [],
      schema_version: 1,
    })
    const message = failed.errors[0]!.message
    expect(message).toContain('ENOTDIR')
    expect(message).toContain('Handoff record could not be written')
    expect(message).not.toContain('/secret/home')

    const unknown = lib.handoffNotRecorded('prod', 'boom').errors[0]!.message
    expect(unknown).toContain('(unknown)')
    expect(unknown).not.toContain('boom')
  })

  test('a regular file where the directory should be makes the write throw', async () => {
    writeFileSync(dir, 'not a directory')
    await expect(write('run-1', 'prod', T0)).rejects.toThrow()
  })
})
