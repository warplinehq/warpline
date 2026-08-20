/**
 * fs-atomic — centralised atomic filesystem writes for `.warpline/` state files.
 *
 * One implementation, not a helper copy-pasted into each plugin that needs it:
 * a half-written state file is the failure this guards against, and a variant
 * that skips a step is indistinguishable from the real thing until it does.
 *
 * Atomic semantics:
 *   1. `mkdir(dirname(path), { recursive: true })` — ensure parent dir exists.
 *   2. Write to `{path}.tmp-{pid}-{rand}`.
 *   3. `rename(tmp, path)` — POSIX-atomic on the same filesystem.
 *   4. On failure (serialise / write / rename), best-effort unlink the temp file
 *      so we never leak half-written artefacts alongside the target.
 */
import { writeFile, rename, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

function tmpSuffix(): string {
  return `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // swallow — temp file may never have been created (serialise failure)
  }
}

/**
 * Atomically write `value` as pretty-printed JSON to `path`. Parent directories
 * are created if missing. On serialise / write / rename failure the target is
 * left untouched.
 */
export async function atomicWriteJson<T>(path: string, value: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}${tmpSuffix()}`
  let serialised: string
  try {
    serialised = JSON.stringify(value, null, 2)
  } catch (err) {
    // JSON.stringify rejects circular refs — nothing written yet, nothing to clean up.
    throw err
  }
  try {
    await writeFile(tmp, serialised, 'utf-8')
    await rename(tmp, path)
  } catch (err) {
    await bestEffortUnlink(tmp)
    throw err
  }
}

/**
 * Atomically write plain text content. Used for markdown files like
 * `current-email-sig.md` that need the same tmp-file-then-rename isolation.
 */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}${tmpSuffix()}`
  try {
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, path)
  } catch (err) {
    await bestEffortUnlink(tmp)
    throw err
  }
}

/**
 * Read + `JSON.parse` a file. Returns `null` for ENOENT. Re-throws any other
 * error (permission, invalid JSON, etc.) — callers that want self-healing
 * behaviour should combine this with `safeParse` at the Zod boundary.
 */
export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
