import { describe, test, expect } from 'bun:test'
import { summariseByLabel } from './handler'

describe('github-poll summariseByLabel', () => {
  test('counts by label, multi-label issues count once per label', () => {
    const counts = summariseByLabel([
      { title: 'a', labels: [{ name: 'bug' }, { name: 'p1' }] },
      { title: 'b', labels: [{ name: 'bug' }] },
    ])
    expect(counts).toEqual({ bug: 2, p1: 1 })
  })

  test('unlabelled issues bucket together; PRs are excluded', () => {
    const counts = summariseByLabel([
      { title: 'a', labels: [] },
      { title: 'pr', labels: [{ name: 'bug' }], pull_request: {} },
    ])
    expect(counts).toEqual({ '(unlabelled)': 1 })
  })
})
