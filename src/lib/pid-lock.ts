/**
 * pid-lock — one symlink-lock primitive and one holder-identity rule, shared
 * by every lock in the home.
 *
 * A lock is a symbolic link whose text names its holder. Whether that holder
 * is gone is judged here and nowhere else, so every lock breaks for the same
 * reason and keeps for the same reason.
 *
 * It imports only `node:*` and `./host-identity.js`, and keeps no held state
 * of its own: each caller records what it holds.
 */
import { readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { deriveHost, isProcessAlive } from './host-identity.js'

let ourHostMemo: { value: string | null } | undefined

/**
 * This machine as a lock names it: § 12's machine identifier, and on Linux
 * that joined by `:` to the pid namespace (`/proc/self/ns/pid`), then by `:`
 * to the boot id (`/proc/sys/kernel/random/boot_id`). Null when any part
 * cannot be had, or the boot id is empty. Memoized, because a process never
 * changes machine, pid namespace or boot.
 *
 * The namespace keeps containers that share `/etc/machine-id` apart. The boot
 * id keeps cloned machines apart, since they share a machine id and the root
 * namespace inode. It also keeps a pid from before a reboot from being tested
 * after it. A mismatch reads as another machine, so the lock is kept.
 * On Linux, a lock left by a crash just before a reboot therefore needs
 * removal by hand. Elsewhere the host outlives a reboot, so a pid from before
 * it is tested after it: a free one is broken, and a reused one reads alive,
 * as the note below says.
 *
 * ponytail: a dead holder whose pid is reused reads alive, and fails closed.
 * A process start time in the identity is the upgrade path: Linux
 * `/proc/PID/stat` field 22, and on macOS a `ps` spawn.
 */
export function ourHost(): string | null {
  if (ourHostMemo === undefined) {
    let value = deriveHost()
    if (value !== null && process.platform === 'linux') {
      try {
        const ns = readlinkSync('/proc/self/ns/pid')
        const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim()
        value = boot === '' ? null : `${value}:${ns}:${boot}`
      } catch {
        value = null
      }
    }
    ourHostMemo = { value }
  }
  return ourHostMemo.value
}

/**
 * Make `path` a symbolic link whose text names its holder:
 * `{ token, pid, host, at }`. True when made, false when something is already
 * at the path, and any other error is thrown.
 *
 * One call makes the entry and its text together, so a lock or break file is
 * never empty or half-written (atomic even over NFS, per Mercurial). It is
 * synchronous, so a caller records what it holds in the same stretch. The text stays far below
 * any link-length limit.
 */
export function take(path: string, token: string): boolean {
  try {
    symlinkSync(JSON.stringify({ token, pid: process.pid, host: ourHost(), at: Date.now() }), path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** A lock or break file as this writer can judge it. */
export type Holder = { token: string | null; pid: number | null; here: boolean; gone: boolean }

/**
 * Who holds the lock or break file at `path`, as far as this writer can tell.
 * Null only when nothing is there.
 *
 * Anything that is not a link whose text parses to an object (a directory, a
 * plain file, any other text) names no holder: no token, no pid, not here, not
 * gone. Otherwise `token` is its string token and `pid` its positive process
 * id, each null when it names none. `here` is true when it names a host equal
 * to this writer's known one. `gone` is true only when it names a token, a pid
 * and this machine, and no such process runs.
 *
 * It reads no time, and a holder it cannot name is never gone.
 */
export function holderOf(path: string): Holder | null {
  let named: { token?: unknown; pid?: unknown; host?: unknown }
  try {
    const parsed: unknown = JSON.parse(readlinkSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { token: null, pid: null, here: false, gone: false }
    named = parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { token: null, pid: null, here: false, gone: false }
  }
  const token = typeof named.token === 'string' ? named.token : null
  const pid = typeof named.pid === 'number' && Number.isSafeInteger(named.pid) && named.pid > 0 ? named.pid : null
  const host = ourHost()
  const here = host !== null && typeof named.host === 'string' && named.host === host
  return { token, pid, here, gone: token !== null && pid !== null && here && !isProcessAlive(pid) }
}

/**
 * Remove a lock whose holder is gone, one writer at a time, and only the lock
 * that was judged.
 *
 * It makes the break file at `breakPath` the way a lock is made. When something is already
 * there it stops: no branch removes or clears a break file this writer did not
 * make. Under its own break file it reads the lock again and judges it again,
 * and removes it only while it still names `token` and its holder is still
 * gone. Then it removes its own break file. Its outcomes:
 *
 * - 'removed': the judged lock is gone, removed here or already.
 * - 'changed': the lock is no longer the one judged (gone, another token, or a
 *   holder that no longer reads as gone), and the caller judges it again at once.
 * - 'kept': the removal itself failed for the judged token: making the break
 *   file threw, or removing the lock threw.
 * - 'break file held': something is already at the break file at `breakPath`.
 *
 * The second judgment is mandatory (Mercurial; GnuPG T5884 is the bug without
 * it). The break runs with no await, and a gone holder cannot release, so the
 * lock cannot change between the second judgment and the removal (review
 * WR-04). The bare break-file removal is safe because no other writer removes
 * or replaces a break file, and nothing awaits between making and removing it
 * (review IN-01 and WR-02), short of a removal by hand inside that window,
 * which § 14 Writing names.
 */
export function breakStale(breakPath: string, lockPath: string, token: string): 'removed' | 'kept' | 'changed' | 'break file held' {
  try {
    if (!take(breakPath, randomUUID())) return 'break file held'
  } catch {
    return 'kept'
  }
  try {
    const now = holderOf(lockPath)
    if (now === null || now.token !== token || !now.gone) return 'changed'
    unlinkSync(lockPath)
    return 'removed'
  } catch (err) {
    // A lock already gone is as good as removed.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'removed' : 'kept'
  } finally {
    try {
      unlinkSync(breakPath)
    } catch {}
  }
}

/**
 * Remove `path` only while it still holds `token`, and say whether this call
 * removed it. Gone, unreadable or another token: not this caller's to remove.
 * Synchronous, so the exit hook can call it.
 */
export function release(path: string, token: string): boolean {
  try {
    const named = JSON.parse(readlinkSync(path, 'utf8')) as { token?: unknown } | null
    if (named?.token !== token) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
