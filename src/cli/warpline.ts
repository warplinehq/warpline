/**
 * `warpline` subcommand dispatcher.
 *
 * Closed for modification after phase 02 plan 01: later plans replace the
 * BODIES of the subcommand modules, never this switch. Adding a subcommand
 * means adding one arm and one line of usage text — nothing else here moves.
 *
 * Two rules that look like oversights and are not:
 *
 *   1. This module NEVER terminates the process. Every subcommand
 *      exports `run(argv): Promise<number>` and this function returns a code;
 *      only `src/bin/warpline.ts` turns a code into an exit. That is what makes
 *      `main()` callable in-process from a test instead of needing a
 *      spawned process per assertion.
 *   2. Each arm uses `await import()`, not a static import. A static import
 *      graph would load every subcommand's dependencies (zod, the engine,
 *      the state manager) to run `--help`.
 *
 * Unknown-command output goes to STDERR with exit code 1; `--help` goes to
 * STDOUT with exit code 0. The two must not be swapped — a shell pipeline
 * reading `warpline --help` must not receive an error message on stdout.
 */

const USAGE = `warpline — deterministic plugin runtime with approval gates

Usage: warpline <command> [options]

Commands:
  plan       Preview the next engine advance without executing it
  scaffold   Generate a new plugin directory from the template
  run        Invoke a single plugin handler directly
  approve    Grant a side-effect approval for this session
  revoke     Clear the current session approval

  --help     Show this message
`

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv

  switch (cmd) {
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0

    case 'plan': {
      const { run } = await import('./plan.js')
      return run(rest)
    }

    case 'scaffold': {
      const { scaffoldPlugin } = await import('./scaffold.js')
      const name = rest[0]
      if (!name) {
        process.stderr.write('Usage: warpline scaffold <plugin-name>\n')
        return 1
      }
      const result = await scaffoldPlugin(name)
      process.stdout.write(`${result.message}\n`)
      return result.created ? 0 : 1
    }

    case 'run': {
      // run-plugin.ts is still a process-entry script that reads
      // process.argv and exits on its own; this extracts a
      // `runPlugin(argv)` from it. Until then, splice our own token out of
      // argv so the script sees the arguments it expects. It exits before
      // control returns here — the `return 1` below is unreachable in
      // practice and exists only to satisfy the return type.
      process.argv = [process.argv[0], process.argv[1], ...rest]
      await import('./run-plugin.js')
      return 1
    }

    case 'approve': {
      const { run } = await import('./approve.js')
      return run(rest)
    }

    case 'revoke': {
      const { run } = await import('./revoke.js')
      return run(rest)
    }

    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n`)
      process.stderr.write(USAGE)
      return 1
  }
}
