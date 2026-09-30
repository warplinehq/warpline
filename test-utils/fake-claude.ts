import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Put a fake command-line tool first on PATH for the length of `fn`.
 *
 * No test may spawn the real tool: it spends money, needs a credential, and
 * reaches a provider. This is still a REAL spawn, through the harness's own
 * argv builder, env builder and stdout parser — only the binary at the end of
 * the lookup is replaced. The spawn finds it because the env builder copies
 * `process.env`, whose PATH carries the prefix for exactly this long.
 *
 * The fake answers `--version` like the real one. Otherwise it writes, into its
 * working directory (the arm's home), `argv.txt` — one argument per line — and
 * `warpline-home.txt` — the home variable it was handed — then runs the
 * optional `before` shell lines and prints the scripted stdout verbatim.
 */
export async function withFakeClaude<T>(
  options: { stdout: string; before?: string },
  fn: (bin: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'warpline-fake-claude-'))
  const priorPath = process.env.PATH
  try {
    const stdoutFile = join(dir, 'stdout.txt')
    await writeFile(stdoutFile, options.stdout)
    const quoted = `'${stdoutFile.split("'").join(`'\\''`)}'`
    const script = [
      '#!/bin/bash',
      'if [ "$1" = "--version" ]; then echo \'0.0.0 (fake)\'; exit 0; fi',
      `printf '%s\\n' "$@" > argv.txt`,
      `printf '%s' "\${WARPLINE_HOME:-}" > warpline-home.txt`,
      options.before ?? '',
      `cat ${quoted}`,
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
