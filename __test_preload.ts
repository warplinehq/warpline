/**
 * bun test preload — safety net for the whole suite.
 *
 * Re-roots WARPLINE_HOME at a throwaway temp dir so a test that forgets to
 * pass an explicit override (or to call _setHome()) writes disposable files
 * instead of live operational state. The source system this was extracted
 * from learned this the hard way: tests + default production paths = silent
 * live-state writes. Path accessors resolve lazily, so setting the env here
 * is ordering-independent — but keep this preload anyway; it is the backstop
 * for code that caches a resolved path.
 *
 * It also owns the two invariants that used to be prose in CLAUDE.md that
 * every caller had to remember: the suite timeout, and the dist/ build.
 * A rule enforced here holds for `bun test`, `bun run test`, CI, and an agent
 * that never read CLAUDE.md. A rule written in prose holds until someone
 * forgets it.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setDefaultTimeout } from 'bun:test'

if (!process.env.WARPLINE_HOME) {
  process.env.WARPLINE_HOME = mkdtempSync(join(tmpdir(), 'warpline-test-home-'))
}

/**
 * bunfig.toml's `[test] timeout` key is silently ignored (bun 1.3.11) — setting
 * it there looks like it works and does nothing. This is the one place that
 * actually raises the default off bun's 5s, which flakes ~3% under CPU
 * contention. Do NOT re-add `--timeout` to invocations; a bare `bun test` is
 * correct. An explicit `--timeout` on the CLI still wins if you need it.
 */
setDefaultTimeout(20_000)

/**
 * The example plugins import `warpline/schemas/*` and `warpline/lib/paths` by
 * package name, self-referencing through the exports map into dist/ — on
 * purpose, because that is the path a real consumer hits from node_modules
 * (`files` ships dist/ and examples/, never src/). So those tests genuinely
 * require a build; the requirement is the point, not a papercut.
 *
 * What was a papercut: forgetting it produced nine unrelated-looking module
 * resolution failures. Make it one line that says what to do.
 */
const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
const BUILD_SENTINEL = join(REPO_ROOT, 'dist', 'schemas', 'plugin-manifest.js')

if (!existsSync(BUILD_SENTINEL)) {
  throw new Error(
    `dist/ is missing — run \`bun run build\` first (or use \`bun run test\`, which builds).\n` +
      `  Expected: ${BUILD_SENTINEL}\n` +
      `  Why: the examples/ tests import \`warpline/*\` through the package exports map, ` +
      `which resolves into dist/. Without a build they fail as unrelated module-resolution errors.`,
  )
}
