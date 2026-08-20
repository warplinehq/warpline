/**
 * Shared StatePaths isolation helper for warpline bun:test files.
 *
 * Packages the the source system's capture/restore contract into a
 * single audited home: `lib/state-manager.ts` exposes a module-global
 * `StatePaths` (the advisory lockfile lives at `paths.lockPath`). A test that
 * calls `_setPaths(tmpDir)` and does not restore the global leaves it pointed at
 * a deleted temp dir; any sibling test in the same `bun test` process that then
 * acquires the state lock ENOENTs on `open(paths.lockPath, 'wx')` — the
 * order-dependent failure Phase 2 caught.
 *
 * `installStatePathIsolation()` is a describe-level hook-installer: call it once
 * at the top of a describe (or top-level in a file with no enclosing describe).
 * It snapshots the current/default StatePaths in `beforeAll` and restores it in
 * `afterAll`. Tests keep calling `_setPaths` freely inside the block; cleanup is
 * automatic, so the global is never leaked to sibling files.
 *
 * StatePaths seam ONLY — do NOT generalize to the intel paths/skill-result
 * snapshot seams (per D-01, only StatePaths is load-bearing for the lock-ENOENT
 * class; the others never `open('wx')` off the global).
 *
 * Usage:
 *   describe('my suite', () => {
 *     installStatePathIsolation()
 *     beforeEach(() => { _setPaths({ ...ownTmpPaths }) })
 *     // ... tests ...
 *   })
 */
import { beforeAll, afterAll } from 'bun:test'
import { _getPaths, _setPaths } from '../src/board/state-manager.js'

/**
 * Describe-level: snapshot StatePaths before the block, restore it after.
 * Tests keep calling `_setPaths` freely inside; the global is restored on
 * teardown so a deleted temp lock path never leaks to a sibling test file.
 */
export function installStatePathIsolation(): void {
  let original: ReturnType<typeof _getPaths>
  beforeAll(() => {
    original = _getPaths()
  })
  afterAll(() => {
    _setPaths(original)
  })
}
