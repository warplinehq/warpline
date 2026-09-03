/**
 * Shared test helper: the whole-home byte snapshot.
 *
 * Every file under `dir`, recursively, as `path|bytes|sha256|mtimeMs`.
 *
 * Deliberately a full recursive walk with NO exclusion list: the moment a path
 * is named as "expected to change", the test stops proving the prohibition and
 * starts documenting an exception. Returned sorted so a mismatch reads as a
 * line diff naming the offending file rather than "Set(9) !== Set(10)".
 *
 * Shared rather than file-local because three test files now need the same
 * walk, and three copies of a walk are three places for an exclusion list to
 * appear in only one of them.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export async function snapshotHome(dir: string): Promise<string[]> {
  const out: string[] = []

  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(child, rel)
        continue
      }
      const [bytes, info] = await Promise.all([readFile(child), stat(child)])
      out.push(
        `${rel}|${bytes.byteLength}|${createHash('sha256').update(bytes).digest('hex')}|${info.mtimeMs}`,
      )
    }
  }

  await walk(dir, '')
  return out.sort()
}
