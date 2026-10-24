import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One shell word, single-quoted, safe for any path or text. */
const quote = (s: string): string => `'${s.split("'").join(`'\\''`)}'`

/**
 * Put a fake command-line tool first on PATH for the length of `fn`.
 *
 * No test may spawn the real tool: it spends money, needs a credential, and
 * reaches a provider. This is still a REAL spawn, through the caller's own
 * argv builder, env builder and stdout parser — only the binary at the end of
 * the lookup is replaced. The bench's spawn finds it because its env builder
 * copies `process.env`, whose PATH carries the prefix for exactly this long. A
 * caller with an allowlisted env resolves the fake's absolute path from that
 * PATH instead.
 *
 * The fake answers `--version` with `version` (default `0.0.0 (fake)`).
 * Otherwise, without `dumpDir`, it writes into its working directory (the
 * arm's home) `argv.txt` — one argument per line — and `warpline-home.txt` —
 * the home variable it was handed. With `dumpDir` it writes nothing into its
 * working directory; it records into `dumpDir`, first, `cwd.txt` (the working
 * directory's listing as it found it), then `argv.txt`, `env.txt`, `pwd.txt`,
 * `stdin.txt` (all of stdin) and one line per call in `calls.txt`. Then it runs
 * the optional `before` shell lines, sleeps `sleepMs`, prints the scripted
 * stdout verbatim and exits with `exitCode` (default 0).
 */
export async function withFakeClaude<T>(
  options: { stdout: string; before?: string; version?: string; dumpDir?: string; sleepMs?: number; exitCode?: number },
  fn: (bin: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'warpline-fake-claude-'))
  const priorPath = process.env.PATH
  try {
    const stdoutFile = join(dir, 'stdout.txt')
    await writeFile(stdoutFile, options.stdout)
    const record =
      options.dumpDir === undefined
        ? [`printf '%s\\n' "$@" > argv.txt`, `printf '%s' "\${WARPLINE_HOME:-}" > warpline-home.txt`]
        : [
            `DUMP=${quote(options.dumpDir)}`,
            'ls -A > "$DUMP/cwd.txt"',
            `printf '%s\\n' "$@" > "$DUMP/argv.txt"`,
            'env > "$DUMP/env.txt"',
            'pwd > "$DUMP/pwd.txt"',
            'cat > "$DUMP/stdin.txt"',
            'echo x >> "$DUMP/calls.txt"',
          ]
    const script = [
      '#!/bin/bash',
      `if [ "$1" = "--version" ]; then echo ${quote(options.version ?? '0.0.0 (fake)')}; exit 0; fi`,
      ...record,
      options.before ?? '',
      options.sleepMs === undefined ? '' : `sleep ${(options.sleepMs / 1000).toFixed(3)}`,
      `cat ${quote(stdoutFile)}`,
      options.exitCode === undefined ? '' : `exit ${options.exitCode}`,
      '',
    ].join('\n')
    const bin = join(dir, 'claude')
    await writeFile(bin, script)
    await chmod(bin, 0o755)
    process.env.PATH = `${dir}:${priorPath ?? ''}`
    return await fn(dir)
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    await rm(dir, { recursive: true, force: true })
  }
}
