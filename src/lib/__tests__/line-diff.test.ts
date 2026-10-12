/**
 * `lineDiff` — the in-repo line diff `warpline approvals show` prints.
 *
 * Each case pins the whole edit script, not a count, so a diff that reorders
 * or drops a line fails here. An empty string is zero lines, and a trailing
 * newline is one more, empty, line.
 */
import { describe, expect, test } from 'bun:test'
import { lineDiff } from '../line-diff.js'

/** The script as the printed lines read: the op, then the line. */
const printed = (before: string, after: string): string[] => lineDiff(before, after).map((e) => `${e.op}${e.line}`)

describe('lineDiff', () => {
  test('identical inputs are all context', () => {
    expect(printed('a\nb\nc', 'a\nb\nc')).toEqual([' a', ' b', ' c'])
  })

  test('one inserted line', () => {
    expect(printed('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c'])
  })

  test('one deleted line', () => {
    expect(printed('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c'])
  })

  test('one replaced line prints the old line, then the new one', () => {
    expect(printed('a\nb\nc', 'a\nx\nc')).toEqual([' a', '-b', '+x', ' c'])
  })

  test('empty before is every line inserted', () => {
    expect(printed('', 'a\nb')).toEqual(['+a', '+b'])
  })

  test('empty after is every line deleted', () => {
    expect(printed('a\nb', '')).toEqual(['-a', '-b'])
  })

  test('a trailing newline is one more, empty, line', () => {
    expect(printed('a\nb', 'a\nb\n')).toEqual([' a', ' b', '+'])
  })

  test('a delete and an insert apart in the middle stay a two-line edit', () => {
    expect(printed('x\na\nb\nc\ny', 'x\nb\nc\nd\ny')).toEqual([' x', '-a', ' b', ' c', '+d', ' y'])
  })
})
