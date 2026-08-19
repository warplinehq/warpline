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
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.WARPLINE_HOME) {
  process.env.WARPLINE_HOME = mkdtempSync(join(tmpdir(), 'warpline-test-home-'))
}
