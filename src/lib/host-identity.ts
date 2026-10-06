/**
 * This machine's identifier and the liveness probe for a process on it.
 * It imports only `node:*`, so a `src/lib` module such as the audit store can use it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'

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
 * initialiser naming a shadowed binding, because a parameter that shadows the
 * binding its own initialiser names is a TDZ error at call time.
 */
export function deriveHost(read: MachineIdReader = readMachineIdFromHost): string | null {
  for (const source of MACHINE_ID_CHAIN) {
    const key = parseMachineId(read(source))
    if (key !== null) return createHmac('sha256', key).update(WARPLINE_APP_ID).digest('hex')
  }
  return null
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
