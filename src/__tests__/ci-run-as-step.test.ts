/**
 * The CI step that runs the tool opt-in's real-user test, pinned: it lives
 * outside the sharded loop, so deleting it or widening its sudo rules would
 * otherwise go unnoticed. The step creates the judge and a narrow operator,
 * installs exactly two sudoers rules, checks them with visudo, prints the
 * listings that show `runner`'s blanket rule is not what lets the test
 * through, and runs the test as that operator.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8')

const RULES = [
  'warpop ALL=(warpline-judge) NOPASSWD:SETENV: /opt/warpline-ci/bin/claude',
  'warpop ALL=(warpline-judge) NOPASSWD: /usr/bin/test',
]

describe('the real-user CI step', () => {
  test.each([
    'useradd -m warpline-judge',
    'useradd -m warpop',
    'chmod 700 /home/warpop',
    ...RULES,
    'visudo -cf',
    'sudo -l -U runner',
    'sudo -l -U warpop',
    'sudo -V',
    'WARPLINE_CI_RUN_AS=warpline-judge',
    'WARPLINE_CI_OPERATOR=warpop',
    'sudo -u warpop',
    './ci/run-as-real-user.test.ts',
  ])('ci.yml contains %s', (needle) => {
    expect(ci.includes(needle)).toBe(true)
  })

  test('every sudoers rule line in ci.yml is one of the two, with no wildcard and no env program', () => {
    const lines = ci.split('\n').filter((l) => l.includes('ALL=('))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(RULES.some((r) => line.includes(r))).toBe(true)
      expect(line.includes('*')).toBe(false)
      expect(/(^|[\s/'"])env(\s|$)/.test(line)).toBe(false)
    }
  })

  test('the fake judge answers --version at the CLI floor', () => {
    const r = spawnSync(join(ROOT, 'test-utils', 'ci-judge-claude.sh'), ['--version'], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stdout.startsWith('2.1.305')).toBe(true)
  })
})
