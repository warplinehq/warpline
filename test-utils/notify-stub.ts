/**
 * Shared `notify` stubs for tests.
 *
 * Each stub is a `/bin/sh` script written under the temp dir a test hands in,
 * and every file it writes lives in that same dir, never anywhere else
 * (AGENTS.md Rule 2). Every script first records its call: one line appended to
 * `notify-<kind>.count`, its arguments one per line then a `---` line in
 * `notify-<kind>.args`, and its `env` output then a `---` line in
 * `notify-<kind>.env`. Then, by kind:
 *
 *   ok    copies stdin to `notify-<kind>.capture` plus a newline, exits 0
 *   fail  drains stdin, exits `exitCode` (3 by default)
 *   hang  drains stdin, touches `startedPath`, optionally starts a background
 *         `sleep <marker>` (the grandchild), then becomes `sleep <marker>`
 *   block copies stdin like `ok`, touches `startedPath`, then waits until
 *         `releasePath` exists and exits 0
 *
 * `marker` is a fractional number of seconds above 50 built from random bytes,
 * so `pgrep -f "sleep <marker>"` matches only this stub's sleeps.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface NotifyStub {
  /** The argv to set as `notify.argv`: the script, then any extra entries. */
  argv: string[]
  /** Each payload the stub received on stdin, parsed as one JSON value per line. */
  messages(): unknown[]
  /** The arguments of each call, in call order. */
  args(): string[][]
  /** The environment of each call, in call order. */
  envs(): Record<string, string>[]
  /** How many times the stub ran. */
  invocations(): number
  startedPath: string
  releasePath: string
  marker: string
}

/** Single-quoted for `sh`, with the `'\''` escape. */
const quote = (s: string): string => `'${s.split("'").join(`'\\''`)}'`

/** The `---`-separated records of a file, each one's lines; empty when the file is absent. */
function records(path: string): string[][] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('---\n')
    .slice(0, -1)
    .map((chunk) => (chunk === '' ? [] : chunk.replace(/\n$/, '').split('\n')))
}

export async function notifyStub(
  dir: string,
  kind: 'ok' | 'fail' | 'hang' | 'block',
  opts: { exitCode?: number; grandchild?: boolean; extraArgs?: string[] } = {},
): Promise<NotifyStub> {
  const base = join(dir, `notify-${kind}`)
  const script = `${base}.sh`
  const countPath = `${base}.count`
  const argsPath = `${base}.args`
  const envPath = `${base}.env`
  const capturePath = `${base}.capture`
  const startedPath = `${base}.started`
  const releasePath = `${base}.release`
  const n = randomBytes(4).readUInt32BE(0)
  const marker = `${51 + (n % 40)}.${String(n).padStart(10, '0')}`

  const body: Record<typeof kind, string[]> = {
    ok: [`cat >> ${quote(capturePath)}`, `echo >> ${quote(capturePath)}`, 'exit 0'],
    fail: ['cat > /dev/null', `exit ${opts.exitCode ?? 3}`],
    hang: [
      'cat > /dev/null',
      `touch ${quote(startedPath)}`,
      ...(opts.grandchild ? [`sleep ${marker} &`] : []),
      `exec sleep ${marker}`,
    ],
    block: [
      `cat >> ${quote(capturePath)}`,
      `echo >> ${quote(capturePath)}`,
      `touch ${quote(startedPath)}`,
      `while [ ! -e ${quote(releasePath)} ]; do sleep 0.05; done`,
      'exit 0',
    ],
  }
  const lines = [
    '#!/bin/sh',
    `echo 1 >> ${quote(countPath)}`,
    `for a in "$@"; do printf '%s\\n' "$a" >> ${quote(argsPath)}; done`,
    `echo --- >> ${quote(argsPath)}`,
    `env >> ${quote(envPath)}`,
    `echo --- >> ${quote(envPath)}`,
    ...body[kind],
    '',
  ]
  await writeFile(script, lines.join('\n'))
  await chmod(script, 0o755)

  return {
    argv: [script, ...(opts.extraArgs ?? [])],
    messages: () =>
      existsSync(capturePath)
        ? readFileSync(capturePath, 'utf-8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as unknown)
        : [],
    args: () => records(argsPath),
    envs: () =>
      records(envPath).map((rec) =>
        Object.fromEntries(
          rec.filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
        ),
      ),
    invocations: () => (existsSync(countPath) ? readFileSync(countPath, 'utf-8').split('\n').filter(Boolean).length : 0),
    startedPath,
    releasePath,
    marker,
  }
}

/**
 * Set `notify` in the preferences file at `prefsPath` by hand, the way an
 * operator's editor would: read the JSON object (an empty one when the file is
 * absent), set the key, write it back. No audit record is written, so the audit
 * store sees a hand edit.
 */
export function setNotify(prefsPath: string, block: Record<string, unknown> | null): void {
  const prefs = existsSync(prefsPath) ? (JSON.parse(readFileSync(prefsPath, 'utf-8')) as Record<string, unknown>) : {}
  prefs.notify = block
  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2))
}
