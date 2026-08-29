import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  BoardEventSchema,
  TaskState,
  ActionType,
  AcknowledgementsSchema,
} from '../board.js'

const validEvent = {
  event_id: 'evt-001',
  type: 'task_created' as const,
  timestamp: '2026-04-06T10:00:00Z',
  source: 'keyword-research',
  summary: 'New keyword research task surfaced: 12 terms with >1k monthly volume',
  severity: 'info' as const,
  task_id: 'task-001',
  metadata_json: null,
}

describe('BoardEventSchema', () => {
  test('Test 1: Valid BoardEvent with type, timestamp, source, summary parses', () => {
    const result = BoardEventSchema.parse(validEvent)
    expect(result.event_id).toBe('evt-001')
    expect(result.type).toBe('task_created')
    expect(result.source).toBe('keyword-research')
    expect(result.summary).toBe(validEvent.summary)
  })

  test('Test 6: BoardEvent fields are flat/scalar (no nested objects — Ink constraint)', () => {
    const result = BoardEventSchema.parse(validEvent)
    // All rendered fields must be scalar
    expect(typeof result.event_id).toBe('string')
    expect(typeof result.type).toBe('string')
    expect(typeof result.timestamp).toBe('string')
    expect(typeof result.source).toBe('string')
    expect(typeof result.summary).toBe('string')
    // metadata_json is a string (serialized) or null — not a nested object
    expect(result.metadata_json === null || typeof result.metadata_json === 'string').toBe(true)
  })

  test('BoardEvent summary is max 200 chars (Ink constraint)', () => {
    const longSummary = 'x'.repeat(201)
    expect(() =>
      BoardEventSchema.parse({ ...validEvent, summary: longSummary })
    ).toThrow(z.ZodError)
  })

  /**
   * Read compatibility, not convenience. `state-manager.ts` safeParses each
   * events.jsonl line on its own and pushes only on success, so a required
   * `run_id` would silently drop every line written before run linkage
   * existed — the whole history, from every board view, with no error.
   */
  test('a line written before run linkage carries no run_id key, parses, and reads null', () => {
    expect('run_id' in validEvent).toBe(false)
    const result = BoardEventSchema.parse(validEvent)
    expect(result.run_id).toBeNull()
  })

  test('a BoardEvent carrying a run_id preserves it as a top-level field', () => {
    const runId = '20260829T101112000Z-ab12cd34'
    const result = BoardEventSchema.parse({ ...validEvent, run_id: runId })
    expect(result.run_id).toBe(runId)
    // Run linkage is a field of its own, never smuggled into metadata_json.
    expect(result.metadata_json).toBeNull()
  })
})

describe('TaskState enum', () => {
  test('Test 3: TaskState must be one of: pending, active, completed, deferred', () => {
    const validStates: z.infer<typeof TaskState>[] = ['pending', 'active', 'completed', 'deferred']
    for (const s of validStates) {
      expect(() => TaskState.parse(s)).not.toThrow()
    }
    expect(() => TaskState.parse('unknown')).toThrow(z.ZodError)
  })
})

describe('ActionType enum', () => {
  test('Test 4: ActionType must be one of: acknowledge, action, defer, mark_done', () => {
    const validActions: z.infer<typeof ActionType>[] = ['acknowledge', 'action', 'defer', 'mark_done']
    for (const a of validActions) {
      expect(() => ActionType.parse(a)).not.toThrow()
    }
    expect(() => ActionType.parse('dismiss')).toThrow(z.ZodError)
  })
})

describe('AcknowledgementsSchema', () => {
  test('Test 5: AcknowledgementsSchema validates map of event_id -> ack state', () => {
    const acks = {
      'evt-001': {
        acknowledged_at: '2026-04-06T11:00:00Z',
        action_taken: 'acknowledge' as const,
      },
      'evt-002': {
        acknowledged_at: '2026-04-06T12:00:00Z',
        action_taken: 'defer' as const,
      },
    }
    const result = AcknowledgementsSchema.parse(acks)
    expect(result['evt-001'].action_taken).toBe('acknowledge')
    expect(result['evt-002'].action_taken).toBe('defer')
  })

  test('Empty acknowledgements map is valid', () => {
    const result = AcknowledgementsSchema.parse({})
    expect(result).toEqual({})
  })
})
