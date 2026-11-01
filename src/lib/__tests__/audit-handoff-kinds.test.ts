/**
 * The two handoff audit kinds, pinned at the store.
 *
 * `handoff.reserved` is the money a try sets aside before it calls a model.
 * `handoff.tried` is how that try ended. Both are strict objects of
 * identifiers, closed enums, digests and integers: every amount is an integer
 * micro-USD, the model ids are a bounded token, and the outcome set is closed.
 * Judgment text never rides either kind, only its byte count and sha256.
 *
 * Every case gets its own temp home (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../audit-log.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'

const SHA = 'b'.repeat(64)
const RESERVATION = 'urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e'

const reserved = { reservation_id: RESERVATION, handoff: 'run-1.prod', amount_micro_usd: 50_000 }
const tried = {
  reservation_id: RESERVATION,
  handoff: 'run-1.prod',
  outcome: 'answered',
  requested: 'claude-opus-5',
  served: 'claude-opus-5',
  cost_micro_usd: 12_300,
  cost_basis: 'reported',
  bytes: 27,
  sha256: SHA,
}

let tmp: string
let statePath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'warpline-audit-handoff-'))
  statePath = join(tmp, 'state', 'engine-state.json')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const anyAppend = audit.appendAudit as (s: string, k: string, d: unknown) => Promise<unknown>

function lines(): { type: string; data: unknown }[] {
  const text = readFileSync(join(tmp, 'audit', '0000000000000001.jsonl'), 'utf-8')
  return text
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; data: unknown })
}

describe('tracer: a reservation and a try append and read back', () => {
  test('the reservation then the try land as the last two lines, data exactly as given', async () => {
    await anyAppend(statePath, 'handoff.reserved', reserved)
    await anyAppend(statePath, 'handoff.tried', tried)
    const [r, t] = lines().slice(-2)
    expect(r!.type).toBe('warpline.audit.handoff.reserved')
    expect(r!.data).toEqual(reserved)
    expect(t!.type).toBe('warpline.audit.handoff.tried')
    expect(t!.data).toEqual(tried)
  })

  test('a try with no text, no served model and no cost: the nullable fields take null', async () => {
    const failed = { ...tried, outcome: 'failed', served: null, cost_micro_usd: null, cost_basis: 'unknown', bytes: null, sha256: null }
    await anyAppend(statePath, 'handoff.tried', failed)
    expect(lines().at(-1)!.data).toEqual(failed)
  })

  test('a reservation of zero, the amount when no cap is set', async () => {
    await anyAppend(statePath, 'handoff.reserved', { ...reserved, amount_micro_usd: 0 })
    expect(lines().at(-1)!.data).toEqual({ ...reserved, amount_micro_usd: 0 })
  })

  test('every try outcome in the closed set appends', async () => {
    for (const outcome of ['answered', 'failed', 'discarded', 'refused']) {
      await anyAppend(statePath, 'handoff.tried', { ...tried, outcome })
      expect((lines().at(-1)!.data as { outcome: string }).outcome).toBe(outcome)
    }
  })
})

describe('the store refuses what the reservation and try shapes do not admit', () => {
  /** Refused by its schema, nothing written, and no refused value in the message. */
  async function refuses(kind: string, data: unknown, values: readonly string[]): Promise<void> {
    await anyAppend(statePath, 'denial.lifted', { plugin: 'p', fingerprint: SHA, principal: null })
    const before = await snapshotHome(tmp)
    let caught: unknown
    try {
      await anyAppend(statePath, kind, data)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(audit.AuditAppendError)
    const message = (caught as Error).message
    expect(message).toBe(`audit store: could not append ${kind}: data rejected by its schema`)
    for (const v of values) expect(message).not.toContain(v)
    expect(await snapshotHome(tmp)).toEqual(before)
  }

  test('a reservation with an unknown key', async () => {
    await refuses('handoff.reserved', { ...reserved, endpoint: 'https://example.test/v1' }, ['endpoint', 'example.test'])
  })

  test('a try carrying Judgment text under an unknown key', async () => {
    await refuses('handoff.tried', { ...tried, judgment: 'the judgment text' }, ['judgment'])
  })

  test('a reservation with a float amount', async () => {
    await refuses('handoff.reserved', { ...reserved, amount_micro_usd: 1.5 }, ['1.5'])
  })

  test('a reservation with a negative amount', async () => {
    await refuses('handoff.reserved', { ...reserved, amount_micro_usd: -1 }, ['-1'])
  })

  test('a reservation with an amount past the safe integers', async () => {
    await refuses('handoff.reserved', { ...reserved, amount_micro_usd: 2 ** 53 }, [String(2 ** 53)])
  })

  test('a try with a float cost', async () => {
    await refuses('handoff.tried', { ...tried, cost_micro_usd: 0.25 }, ['0.25'])
  })

  test('a try with no requested model', async () => {
    await refuses('handoff.tried', { ...tried, requested: null }, [])
  })

  test('a try whose served model holds whitespace', async () => {
    await refuses('handoff.tried', { ...tried, served: 'a b' }, ['a b'])
  })

  test('a try whose outcome is recovered, which only the record carries', async () => {
    await refuses('handoff.tried', { ...tried, outcome: 'recovered' }, ['recovered'])
  })

  test('a reservation whose handoff is a path', async () => {
    await refuses('handoff.reserved', { ...reserved, handoff: '../x' }, ['../x'])
  })

  test('a try whose requested model is 201 characters', async () => {
    const long = 'm'.repeat(201)
    await refuses('handoff.tried', { ...tried, requested: long }, [long])
  })

  test('a try whose cost basis is outside the closed set', async () => {
    await refuses('handoff.tried', { ...tried, cost_basis: 'guessed' }, ['guessed'])
  })

  test('a try with a sha256 that is not lowercase hex', async () => {
    await refuses('handoff.tried', { ...tried, sha256: 'B'.repeat(64) }, ['BBBB'])
  })
})

describe('the model-id token and the closed try outcomes', () => {
  test('MODEL_ID admits the ids operators configure and providers report', () => {
    for (const id of [
      'claude-opus-5',
      'x-20261001',
      'us.anthropic.claude-opus-4-8',
      'claude-haiku-4-5@20251001',
      'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6',
      'opus[1m]',
      'm'.repeat(200),
    ]) {
      expect([id, audit.MODEL_ID.test(id)]).toEqual([id, true])
    }
  })

  test('MODEL_ID refuses whitespace, control characters, quotes, query characters and 201 characters', () => {
    for (const id of [
      '',
      'a b',
      'a\tb',
      'a\nb',
      'a\x00b',
      'a"b',
      "a'b",
      'a?b',
      'a&b',
      'a=b',
      '-leading',
      'm'.repeat(201),
    ]) {
      expect([id, audit.MODEL_ID.test(id)]).toEqual([id, false])
    }
  })

  test('the try outcomes are exactly the closed set, and recovered is not one', () => {
    expect([...audit.TRIED_OUTCOMES]).toEqual(['answered', 'failed', 'discarded', 'refused'])
  })
})
