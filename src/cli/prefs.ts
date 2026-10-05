/**
 * `warpline prefs set <dotted.key> <json-value>` — change one guardrail in
 * preferences.json, on the audit record.
 *
 * The record goes first: `preference.set` names the key path and the sha256 of
 * the old file bytes and of the bytes about to be written, then the file is
 * written through fs-atomic. The new digest is over exactly those bytes, so the
 * next read of the file finds it matching the store and records no hand edit.
 * A hand edit already pending is recorded before the set, the same way every
 * read of the file records one.
 *
 * A failed append writes nothing: a guardrail change with no record is the
 * thing this verb exists to prevent. A value already in effect writes and
 * records nothing. No message ever repeats the typed value, because stderr
 * reaches run logs and scheduler mail; refusals name key paths and schema
 * facts only.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import { appendAudit, observeAuthorityFile } from '../lib/audit-log.js'
import { engineStatePath, preferencesPath } from '../lib/paths.js'
import { PreferencesInvalidError, readPreferencesFile, setPreference, writePreferences } from '../lib/preferences.js'

export const USAGE = `Usage: warpline prefs set <dotted.key> <json-value>

Sets one key in preferences.json, for example \`review_gate true\` or
\`retention.days 7\`. The change is recorded on the audit store before the file
is written.
`

const AUDIT_FAILED = 'The audit store could not record this change. Nothing was written.\n'

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export async function run(argv: string[]): Promise<number> {
  // No flag parser: the value is any JSON, and a parser would read `-5` as an
  // unknown option and quote it back in its error.
  const [sub, key, raw, ...extra] = argv
  if (sub !== 'set' || key === undefined || raw === undefined || extra.length > 0) {
    process.stderr.write(USAGE)
    return 1
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    process.stderr.write(`prefs set: the value is not JSON.\n\n${USAGE}`)
    return 1
  }

  // The read, the record and the write are one step under the state lock, so
  // two sets at once cannot both read the same file and lose one write.
  const { lockPath } = pathsForStateFile(engineStatePath())
  await mkdir(dirname(lockPath), { recursive: true })
  return await withStateLockAt(lockPath, () => setLocked(key, value))
}

async function setLocked(key: string, value: unknown): Promise<number> {
  const prefsPath = preferencesPath()
  let current: Awaited<ReturnType<typeof readPreferencesFile>>
  try {
    current = await readPreferencesFile(prefsPath)
  } catch (err) {
    if (!(err instanceof PreferencesInvalidError)) throw err
    process.stderr.write(`${err.message}\n`)
    return 1
  }

  try {
    await observeAuthorityFile(engineStatePath(), 'preferences.observed', current.bytes)
  } catch {
    process.stderr.write(AUDIT_FAILED)
    return 1
  }

  let next
  try {
    next = setPreference(current.prefs, key, value, prefsPath)
  } catch (err) {
    if (!(err instanceof PreferencesInvalidError)) throw err
    process.stderr.write(`prefs set: ${err.reason}.\n`)
    return 1
  }

  if (JSON.stringify(next) === JSON.stringify(current.prefs)) {
    process.stdout.write(`${key} already has that value. Nothing was written.\n`)
    return 0
  }

  // Exactly what atomicWriteJson writes.
  const bytes = Buffer.from(JSON.stringify(next, null, 2), 'utf-8')
  try {
    await appendAudit(engineStatePath(), 'preference.set', {
      key,
      old: current.bytes === null ? null : sha256(current.bytes),
      new: sha256(bytes),
    })
  } catch {
    process.stderr.write(AUDIT_FAILED)
    return 1
  }

  try {
    await writePreferences(prefsPath, next)
  } catch {
    process.stderr.write(
      'prefs set: preferences.json could not be written. The audit record names a change that did not ' +
        'happen, and the next read records the file as it is.\n',
    )
    return 1
  }
  process.stdout.write(`Set ${key}. The change is on the audit record.\n`)
  return 0
}
