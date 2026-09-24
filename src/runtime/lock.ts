import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { atomicWriteText } from '../lib/fs-atomic.js'

export const WarplineLockSchema = z.object({
  acquired_at: z.string(),
  run_id: z.string(),
  mode: z.string(),
  /**
   * PID of the lock-holding process, or null for orchestrator-held locks.
   * An LLM-orchestrator session acquires the lock through a short-lived
   * bun process whose PID is dead moments later — a numeric PID there makes
   * every liveness check classify the live run's lock as stale (and clean
   * it mid-run). Null opts out of the liveness check; the two-hour window
   * since the last heartbeat still expires abandoned locks.
   */
  pid: z.number().nullable(),
  /**
   * Which machine holds the lock, or null when this one could not identify
   * itself. A pid is only meaningful against the kernel that issued it, and a
   * home can be attached from more than one machine, so without this field
   * machine B reads machine A's live lock as stale and heals it — two writers
   * on one home, the one failure the lock exists to prevent.
   *
   * Null means the derivation chain found nothing here. It costs the liveness
   * check: a lock with a null host on either side is never judged dead by pid
   * and expires only by the two-hour window. Two null hosts NEVER compare
   * equal — that is the whole of the rule, and it is what Git's `gc.pid` gets
   * wrong by writing a literal placeholder string on failure, which makes two
   * machines that could not identify themselves look like the same machine.
   *
   * Optional as well as nullable, and the optionality is load-bearing. A
   * required field makes every in-flight lock written by the previous build
   * unparseable, an unparseable lock is refused rather than broken, and so the
   * upgrade would strand every home that had an advance running when it
   * happened. A record with no `host` key behaves as the null case.
   */
  host: z.string().nullable().optional(),
  /**
   * When the holder last said it is still running. Written at acquire, equal to
   * `acquired_at`, and refreshed by the holder every minute while its advance
   * runs (`startHeartbeat`). The two-hour window is measured from it, so a
   * holder that is alive is never healed however long its advance runs, and one
   * that stopped refreshing, wedged or gone, still is.
   *
   * Optional for the reason `host` is. A lock written by an older build has no
   * such key and is measured from `acquired_at`, as that build measures every
   * lock. That build also drops the key when it reads a lock this one wrote, so
   * a home attached from both heals a long advance at two hours from its start
   * until every attached build has this field.
   */
  heartbeat_at: z.string().optional(),
})

export type WarplineLock = z.infer<typeof WarplineLockSchema>

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

/**
 * How often a holder refreshes `heartbeat_at`. One small atomic write a minute,
 * and a hundred and twenty refreshes inside the two-hour window, so a refresh
 * that fails now and then costs nothing.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000

let heartbeatIntervalOverride: number | null = null

/**
 * Test-only: refresh every `ms` rather than every minute, so a test advance
 * lives long enough to see a refresh. Pass null to restore the default.
 */
export function _setHeartbeatInterval(ms: number | null): void {
  heartbeatIntervalOverride = ms
}

/**
 * The links of the host-identity chain, in the order they are consulted.
 *
 * Never the machine's operator-facing name: that is operator-chosen, routinely
 * duplicated across a fleet, and changes without the machine changing.
 */
export const MACHINE_ID_CHAIN = ['etc-machine-id', 'dbus-machine-id', 'ioreg-platform-uuid'] as const

export type MachineIdSource = (typeof MACHINE_ID_CHAIN)[number]

/**
 * One link of the chain, read.
 *
 * Injectable because the chain CANNOT be exercised end to end anywhere: links
 * one and two are absent on macOS and link three is absent on Linux CI. Probing
 * the real host would leave the `null` arm untested wherever the chain happens
 * to succeed, and the success arm untested wherever it fails — and the `null`
 * arm is the one whose correctness matters most.
 */
export type MachineIdReader = (source: MachineIdSource) => string | null

/**
 * The message half of the host HMAC: arbitrary, chosen once, and fixed.
 *
 * Changing this value invalidates every host identifier already written into
 * a lock file — every such lock then reads as a foreign host and expires only
 * by the two-hour TTL. There is no reason to change it.
 */
const WARPLINE_APP_ID = '6f2a9c41-7b58-4d3e-9a06-c15d8e47b230'

/**
 * A link's answer as 16 raw bytes, or null when it is not a parseable id.
 *
 * Both shapes the chain can hand back parse the same way: a machine id is 32
 * hex digits, and an `IOPlatformUUID` is the same 16 bytes written with
 * hyphens. Anything else — empty, whitespace, the wrong length, not hex — is
 * not an identifier and falls through to the next link rather than being
 * derived from as-is.
 */
function parseMachineId(raw: string | null): Buffer | null {
  if (raw === null) return null
  const hex = raw.trim().replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

/**
 * The real chain. Every failure is a fall-through, never a throw: an absent
 * file and an absent `ioreg` are the ordinary case on the other platform.
 */
export function readMachineIdFromHost(source: MachineIdSource): string | null {
  try {
    switch (source) {
      case 'etc-machine-id':
        return readFileSync('/etc/machine-id', 'utf-8')
      case 'dbus-machine-id':
        return readFileSync('/var/lib/dbus/machine-id', 'utf-8')
      case 'ioreg-platform-uuid': {
        const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null
      }
    }
  } catch {
    return null
  }
}

/**
 * This machine's identifier for the lock file, or null when it has none.
 *
 * The machine id is the HMAC **key** — its 16 raw bytes — and a fixed
 * warpline application UUID is the message. What that construction buys is
 * exactly what `machine-id(5)` asks for when it says the id "must not be used
 * directly" and "must not be exposed ... on the network": the stored value
 * cannot be used AS a machine id anywhere else, so a home on a network mount
 * does not hand other software an identifier it will accept. It does NOT buy
 * unguessability. A fixed-constant key over the machine id as message is
 * equally enumerable across a known fleet's id space, and so is this
 * direction — the attacker knows the public half either way. Do not argue for
 * the construction on those grounds here or anywhere else.
 *
 * Two caveats, stated rather than verified. (a) Raw-16-bytes and hex-text keys
 * produce different values; nothing else derives this identifier, so
 * interoperability is not a requirement and the choice does not turn on which
 * one systemd uses. (b) That this matches
 * `sd_id128_get_machine_app_specific`'s direction is taken from the documented
 * remedy in `machine-id(5)` and is not verified against the systemd source.
 *
 * The honest ceiling: where a container image bakes in a machine id, or two
 * containers bind-mount one, the identifier lies in the dangerous direction —
 * two machines look like one — and warpline cannot detect it. A
 * PID-namespace-based identity is the upgrade path and is out of scope.
 *
 * The reader is a parameter because the chain cannot be exercised end to end
 * in any one environment. Its default is the accessor above rather than an
 * initialiser naming a shadowed binding, for the reason the block comment
 * below gives about call-time TDZ.
 */
export function deriveHost(read: MachineIdReader = readMachineIdFromHost): string | null {
  for (const source of MACHINE_ID_CHAIN) {
    const key = parseMachineId(read(source))
    if (key !== null) return createHmac('sha256', key).update(WARPLINE_APP_ID).digest('hex')
  }
  return null
}

/**
 * Every function below takes its lock path as a REQUIRED first parameter.
 *
 * There used to be a module-load-time constant here holding `lockPath()`,
 * which is the one thing `src/lib/paths.ts:17-21` tells you not to write:
 * a path frozen at import time survives a later re-root. `bench/run.ts` swaps
 * `WARPLINE_HOME` per iteration and `bench/arms.ts` calls `runAdvance()` with
 * no options, so a frozen default would put the bench's lock in the wrong home
 * and let two advances both acquire — the exact failure the lock exists to
 * prevent. The derivation belongs at the call site, in the engine.
 *
 * Do NOT bring the default back as `lockPath: string = lockPath()`: inside
 * these signatures the parameter shadows the accessor of the same name, so
 * that initialiser is a TDZ error at call time.
 */

export function generateRunId(): string {
  const now = new Date()
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  const nonce = randomBytes(4).toString('hex')
  return `${ts}-${nonce}`
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    // EPERM means the process exists and belongs to another user, so we are not
    // allowed to signal it. That is not the same as gone, and reading it as gone
    // is what lets the heal path break a live holder's lock. Only ESRCH is dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Is this lock safe to break?
 *
 * The TTL branch is unconditional, and it measures from the holder's last
 * heartbeat, or from `acquired_at` for a lock that carries none. The pid branch
 * is reached only when the lock's host and this machine's host are BOTH known
 * and equal — anything else is a pid from a kernel that is not this one, and
 * `process.kill(pid, 0)` answers about the local kernel whatever the lock says.
 * Either side null, either side absent, or the two known and different: the pid
 * branch is skipped entirely and only the two-hour window expires the lock.
 */
export function isLockStale(lock: WarplineLock, read: MachineIdReader = readMachineIdFromHost): boolean {
  const age = Date.now() - new Date(lock.heartbeat_at ?? lock.acquired_at).getTime()
  if (age > TWO_HOURS_MS) return true
  if (lock.pid === null) return false
  const theirs = lock.host ?? null
  const ours = deriveHost(read)
  if (theirs === null || ours === null || theirs !== ours) return false
  return !isProcessAlive(lock.pid)
}

/**
 * The run lock is held by someone else, and this process is not going to wait.
 *
 * `name` is assigned explicitly because the codebase duck-types on `err.name`
 * rather than `instanceof` — see `main`'s `EngineStateInvalidError` catch in
 * `warpline.ts` — which is what lets the CLI map a contention to an exit code
 * without importing this class. Cited by symbol rather than by line number,
 * because the line this used to name moved into a different arm.
 */
export class AdvanceLockedError extends Error {
  readonly lockPath: string
  readonly pid: number | null
  constructor(lockPath: string, pid: number | null, detail?: string) {
    super(
      detail ??
        (pid === null
          ? `Run lock at ${lockPath} is held by an orchestrator session.`
          : `Run lock at ${lockPath} is held by PID ${pid}.`)
    )
    this.name = 'AdvanceLockedError'
    this.lockPath = lockPath
    this.pid = pid
  }
}

/**
 * The refusal to raise when the lock is held and must not be broken.
 *
 * A `null` holder is an unreadable one: `readLock` answers `null` for a
 * truncated file and for JSON that is not a lock, and neither may be unlinked.
 * Unlinking a file whose contents you could not verify is how two writers get
 * one home; an operator who can write a malformed lock can deny service, which
 * is the strictly better failure.
 */
function lockedError(lockPath: string, held: WarplineLock | null): AdvanceLockedError {
  if (held === null) {
    return new AdvanceLockedError(
      lockPath,
      null,
      `Run lock at ${lockPath} is held by a file that could not be read back as a lock; refusing rather than breaking it.`
    )
  }
  return new AdvanceLockedError(lockPath, held.pid)
}

/**
 * Take the run lock, healing one stale holder.
 *
 * Refuses rather than waits. Under a 15-minute scheduler tick the tick IS the
 * retry, and a waiting acquire under a scheduler is a queue of advances nobody
 * asked for. So: one exclusive create, and on contention exactly one heal and
 * one retry — no loop, no timeout, no flag that breaks a held lock.
 */
export async function acquireLock(
  lockPath: string,
  mode: string = 'health',
  opts: { pid?: number | null; readMachineId?: MachineIdReader } = {}
): Promise<WarplineLock> {
  const read = opts.readMachineId ?? readMachineIdFromHost
  // { flag: 'wx' } = O_CREAT|O_EXCL — exclusive create, EEXIST if the path is
  // taken, and it refuses a symlink rather than following one. Do not replace
  // it with an existence check and a write; that is the TOCTOU race this flag
  // exists to remove.
  const write = async (): Promise<WarplineLock> => {
    const acquiredAt = new Date().toISOString()
    const lock: WarplineLock = {
      acquired_at: acquiredAt,
      run_id: generateRunId(),
      mode,
      pid: opts.pid === undefined ? process.pid : opts.pid,
      host: deriveHost(read),
      // The lease exists from the first instant, before any refresh.
      heartbeat_at: acquiredAt,
    }
    // The lock is the FIRST writer in an advance, and every other writer in
    // this tree does its own recursive mkdir before it writes. This one is the
    // exception that used to matter most: without it a home that has never
    // been advanced can never be advanced, because `warpline init` creates
    // `config/` and `plugins/` and nothing creates the directory the lock goes
    // in. Inside `write` rather than above the try, so the post-heal retry
    // gets it too.
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' })
    return lock
  }

  try {
    return await write()
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  const held = await readLock(lockPath)
  if (held === null || !isLockStale(held, read)) throw lockedError(lockPath, held)

  // Stale. Break it and retry once. The window between the unlink and the
  // retry is the same race `state-manager.ts:112-116` already accepts in
  // production: another process can win the retry, and then this one refuses
  // by name rather than trying again — which is only true because the unlink
  // is scoped to the stale lock this call read back. An unconditional unlink
  // here removed the winner's fresh lock and let both processes proceed.
  await unlinkIfOwned(lockPath, held.run_id)

  try {
    return await write()
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    throw lockedError(lockPath, await readLock(lockPath))
  }
}

/**
 * Give up the lock this run took.
 *
 * `runId` is REQUIRED, and it is the whole of the change: a release that
 * unlinks whatever is at the path deletes the next advance's live lock every
 * time its own lock was healed out from under it. Pass the `run_id` off the
 * lock `acquireLock` returned — never a fresh one, and never a `run_id` read
 * back off disk, which is the check rather than the input to it.
 */
export async function releaseLock(lockPath: string, runId: string): Promise<void> {
  await unlinkIfOwned(lockPath, runId)
}

/**
 * Move `heartbeat_at` of the lock at `lockPath` to now, if it is still the one
 * `runId` took. Returns whether it was.
 *
 * Never writes a lock this run does not hold. Like `unlinkIfOwned`, this
 * NARROWS a window it cannot close: the read and the rename are not atomic, and
 * a second process can heal and acquire in between, and then the rename writes
 * over the winner's lock. That is reachable only once this holder's heartbeat is
 * already older than the two-hour window, which means this process was wedged
 * or asleep for that long. The rename is atomic, so a reader never sees a torn
 * lock, which it would refuse rather than break.
 *
 * Only two answers mean "not this run's": the file is gone, or it parses as a
 * lock with another `run_id`. Anything else, a read that fails or a file that
 * does not parse as a lock, is "could not look", and it throws. The heartbeat
 * retries a throw on the next tick. Answering it `false`, as `readLock`'s one
 * `null` would, stopped the heartbeat for good on a single EACCES, and the live
 * holder was healed two hours later.
 */
export async function refreshLock(lockPath: string, runId: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(lockPath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  const current = WarplineLockSchema.parse(JSON.parse(raw))
  if (current.run_id !== runId) return false
  await atomicWriteText(lockPath, JSON.stringify({ ...current, heartbeat_at: new Date().toISOString() }, null, 2))
  return true
}

/**
 * Refresh this run's lock every `intervalMs` until the returned stop is
 * awaited. The advance starts it right after it acquires and awaits the stop
 * right before it releases.
 *
 * **The stop waits for a refresh already in flight.** A refresh that read the
 * lock as this run's and renames after the release would put the lock back,
 * held by a run that has finished, and every later advance would be refused
 * until the window expires. So the release must never run before the last
 * refresh has settled.
 *
 * **A tick never throws.** A refresh that fails, on a full disk or a lost mount,
 * in its read or its write, only leaves the heartbeat older, which is the safe
 * direction, and the next tick tries again. A tick that finds a refresh still
 * in flight skips rather than queueing behind it.
 *
 * **It stops for good the first time the lock is not this run's**, healed and
 * taken by another advance or removed by hand. The advance goes on; its writes
 * are merged under the state lock either way. A lock it could not read is not
 * "not this run's" (`refreshLock`).
 *
 * The interval is unref'd, so it never holds a process open on its own.
 * `refresh` is injectable for the tests that hold a refresh in flight.
 */
export function startHeartbeat(
  lockPath: string,
  runId: string,
  opts: { intervalMs?: number; refresh?: (lockPath: string, runId: string) => Promise<boolean> } = {},
): () => Promise<void> {
  const refresh = opts.refresh ?? refreshLock
  let stopped = false
  let inFlight: Promise<void> | null = null
  const timer = setInterval(() => {
    if (stopped || inFlight !== null) return
    inFlight = refresh(lockPath, runId)
      .then((ours) => {
        if (!ours) stop()
      })
      .catch(() => {})
      .finally(() => {
        inFlight = null
      })
  }, opts.intervalMs ?? heartbeatIntervalOverride ?? HEARTBEAT_INTERVAL_MS)
  timer.unref()
  const stop = (): void => {
    stopped = true
    clearInterval(timer)
  }
  return async () => {
    stop()
    await inFlight
  }
}

/**
 * Unlink the lock at `lockPath` only if it is still the one `runId` took.
 *
 * Both unlinks in this module used to be unconditional, which is how one
 * advance came to delete another's live lock. Two shapes, both ordinary:
 * two processes read the same stale lock, the second heals and acquires, and
 * the first's heal then removes the winner's fresh lock; or an advance whose
 * own lock aged past the TTL is healed by the next tick, and its release
 * deletes the second advance's live lock on the way out.
 *
 * This NARROWS the window, it does not close it. A read followed by an unlink
 * is not atomic, and the holder can still change in between — there is no
 * portable compare-and-delete. What it buys is that the common case stops
 * being a silent double-writer, and the residual is a window of microseconds
 * rather than the whole length of a run.
 *
 * A `null` read is left alone, for the reason `readLock` gives: an absent file
 * needs no unlink, and a file that could not be read back as a lock must not be
 * broken by anyone. The cost, named rather than discovered: if this process's
 * own lock is corrupted while it holds it, the release leaves it behind and
 * nothing heals it — an unreadable lock is refused rather than broken on the
 * acquire path too, so it takes an operator deleting the file by hand.
 */
async function unlinkIfOwned(lockPath: string, runId: string): Promise<void> {
  const current = await readLock(lockPath)
  if (current === null || current.run_id !== runId) return
  try {
    await unlink(lockPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Read the lock back, or null — for an absent file, for a truncated one, and
 * for JSON that is not a lock. Callers get one answer for "I could not read a
 * lock here", and none of them may unlink on it.
 */
export async function readLock(lockPath: string): Promise<WarplineLock | null> {
  try {
    const raw = JSON.parse(await readFile(lockPath, 'utf-8'))
    const result = WarplineLockSchema.safeParse(raw)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
