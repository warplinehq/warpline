import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { OUTPUT_BODY_CAP_BYTES } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The contacts file, at input `contacts_path`:
 * { "contacts": [{ "id": "c-1", "email": "c-1@example.com", "enrolled_at": "2026-01-05T09:00:00Z" }] }
 *
 * The steps file, at input `steps_path`, offsets in ascending order:
 * { "steps": [{ "offset_days": 0, "subject": "Hello", "body": "First note" }] }
 *
 * The replies come from `cadence-replies`, through the dependency member:
 * { "replied": ["c-1"] }
 *
 * Own state, `<home>/state/cadence-plan.stopped.json`, every contact ever stopped:
 * { "stopped": ["c-1"] }
 *
 * The Output body, which is what an operator approves and `cadence-send` ships:
 * { "outbox": [Email], "review_tasks": [ReviewTask] }
 */
export interface Contact { id: string; email: string; enrolled_at: string }
export interface Step { offset_days: number; subject: string; body: string }
export interface Email { id: string; contact_id: string; step: number; to: string; subject: string; body: string; due_at: string }
export interface ReviewTask { contact_id: string; email: string; task: string }

const DAY_MS = 86_400_000
const REVIEW = 'replied: review the thread and decide the next touch by hand'

/** `<` and `>`, not `localeCompare`: the order must not depend on the host locale. */
const byId = (a: Contact, b: Contact): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The emails due at `now`, the review tasks, and the full stopped set.
 *
 * Pure, so a test can pin the clock. The handler passes `new Date()`.
 *
 * A step is due once `enrolled_at + offset_days` is at or before `now`, and a
 * contact gets the latest due step only. A reply wins over a due step in the
 * same run: the contact is stopped, nothing is queued, and a review task is
 * emitted instead. Contacts are walked in id order, so the file's order never
 * moves a byte of the result.
 */
export function planOutbox(
  contacts: Contact[],
  steps: Step[],
  replied: readonly string[],
  stopped: readonly string[],
  now: Date,
): { outbox: Email[]; review_tasks: ReviewTask[]; stop: string[] } {
  const repliedSet = new Set(replied)
  const stop = [...new Set([...stopped, ...replied])].sort()
  const stopSet = new Set(stop)
  const sorted = [...contacts].sort(byId)

  const review_tasks: ReviewTask[] = sorted
    .filter((c) => repliedSet.has(c.id))
    .map((c) => ({ contact_id: c.id, email: c.email, task: REVIEW }))

  const outbox: Email[] = []
  for (const c of sorted) {
    if (stopSet.has(c.id)) continue
    const start = Date.parse(c.enrolled_at)
    let due = -1
    for (const [i, s] of steps.entries()) {
      if (start + s.offset_days * DAY_MS <= now.getTime()) due = i
    }
    if (due < 0) continue
    const s = steps[due]!
    outbox.push({
      id: `${c.id}:${due + 1}`,
      contact_id: c.id,
      step: due + 1,
      to: c.email,
      subject: s.subject,
      body: s.body,
      due_at: new Date(start + s.offset_days * DAY_MS).toISOString(),
    })
  }
  return { outbox, review_tasks, stop }
}

/**
 * A path under the home and nowhere else: no leading separator, no drive
 * letter, no `..` segment.
 */
export function isUnderHome(rel: string): boolean {
  if (rel === '' || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) return false
  return !rel.split(/[\\/]/).includes('..')
}

/**
 * A configured value, or the manifest's own default when the caller left it
 * out. The runtime merges defaults before a handler is called; a host that
 * calls the handler directly may not, and the default lives in ONE place.
 */
function configured(manifest: PluginManifest, args: Record<string, unknown>, key: string): unknown {
  return args[key] !== undefined ? args[key] : manifest.inputs[key]?.default
}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** The first bad contact's 1-based position, or 0 when every entry is a contact. */
function badContact(list: unknown[]): number {
  const i = list.findIndex((c) => {
    const o = c as Partial<Record<keyof Contact, unknown>> | null
    return o === null || typeof o !== 'object' || !isText(o.id) || !isText(o.email)
      || typeof o.enrolled_at !== 'string' || !Number.isFinite(Date.parse(o.enrolled_at))
  })
  return i + 1
}

/** The first bad step's 1-based position, or 0. Offsets must not go down. */
function badStep(list: unknown[]): number {
  let last = 0
  const i = list.findIndex((s) => {
    const o = s as Partial<Record<keyof Step, unknown>> | null
    if (o === null || typeof o !== 'object' || typeof o.subject !== 'string' || typeof o.body !== 'string') return true
    if (typeof o.offset_days !== 'number' || !Number.isFinite(o.offset_days) || o.offset_days < last) return true
    last = o.offset_days
    return false
  })
  return i + 1
}

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }
  const fail = (message: string) => skillFailure('parse_error', `${manifest.name}: ${message}`, FAILED)
  // An empty outbox, never no Output. With no Output the runtime carries the
  // last one forward, and cadence-send refuses to ship it until this plugin
  // produces again. The empty outbox says "nothing to send" in bytes an
  // operator can read and approve, and it replaces the old outbox at once.
  const EMPTY = JSON.stringify({ outbox: [], review_tasks: [] })
  const nothing = (why: string) => skillOk(`${manifest.name}: ${why}`, {
    phases_completed: [manifest.name],
    artifacts_produced: [{ type: 'outbox', format: 'json', body: EMPTY }],
  })

  // Reply detection first. With no reply list there is no plan: an email
  // queued without it could go to somebody who already answered.
  const record = capabilities.dependencies.lastOutput(capabilities.caller, 'cadence-replies')
  // Never produced, so this plugin never produced either: no Output to replace.
  if (record === null) return skillOk(`${manifest.name}: no data from cadence-replies yet — nothing to plan`, { phases_completed: [manifest.name] })
  if (record.body === undefined) return nothing('the cadence-replies Output is not held inline — nothing to plan')
  let replied: unknown
  try {
    replied = (JSON.parse(record.body) as { replied?: unknown } | null)?.replied
  } catch {
    replied = undefined
  }
  if (!Array.isArray(replied) || !replied.every((r) => typeof r === 'string')) {
    return fail("cadence-replies' Output is not a replies list — refusing to plan without reply detection")
  }

  // Own state, derived from the manifest name. Unreadable is never read as
  // empty: an empty stopped list would message every contact who replied.
  const stoppedPath = join(warplineHome(), 'state', `${manifest.name}.stopped.json`)
  let stored: string[]
  try {
    const raw = await readJsonOrNull<{ stopped?: unknown }>(stoppedPath)
    if (raw === null) stored = []
    else if (typeof raw === 'object' && Array.isArray(raw.stopped) && raw.stopped.every((s) => typeof s === 'string')) stored = raw.stopped
    else throw new Error('not a stopped list')
  } catch {
    return fail('the stopped list is unreadable — refusing to plan (it would message contacts who replied)')
  }
  // Written before the contacts and steps are read: a detected reply is
  // permanent even on a run that goes on to plan nothing.
  const merged = [...new Set([...stored, ...replied])].sort()
  if (JSON.stringify(merged) !== JSON.stringify(stored)) await atomicWriteJson(stoppedPath, { stopped: merged })

  // Configured paths are refused by key, and no arm below names the value.
  const read = async (key: string, field: string): Promise<{ list: unknown[] } | { done: ReturnType<typeof fail> }> => {
    const rel = configured(manifest, args, key)
    if (typeof rel !== 'string' || !isUnderHome(rel)) {
      return { done: fail(`input '${key}' must be a relative path under the warpline home with no '..' segment`) }
    }
    let raw: Record<string, unknown> | null
    try {
      raw = await readJsonOrNull<Record<string, unknown>>(join(warplineHome(), rel))
    } catch {
      return { done: fail(`the file named by input '${key}' is unreadable or not JSON`) }
    }
    if (raw === null) return { done: nothing(`no file at input '${key}' — nothing to plan`) }
    const list = typeof raw === 'object' ? raw[field] : undefined
    if (!Array.isArray(list)) return { done: fail(`the file named by input '${key}' must hold { "${field}": [...] }`) }
    return { list }
  }
  const contactsRead = await read('contacts_path', 'contacts')
  if ('done' in contactsRead) return contactsRead.done
  const stepsRead = await read('steps_path', 'steps')
  if ('done' in stepsRead) return stepsRead.done

  const badC = badContact(contactsRead.list)
  if (badC > 0) {
    return fail(`entry ${badC} of the file named by input 'contacts_path' needs a non-empty id and email and an enrolled_at date`)
  }
  const badS = badStep(stepsRead.list)
  if (badS > 0) {
    return fail(`entry ${badS} of the file named by input 'steps_path' needs a subject, a body and an offset_days no lower than the step before`)
  }
  const contacts = contactsRead.list as Contact[]
  const steps = stepsRead.list as Step[]
  const seen = new Set<string>()
  for (const c of contacts) {
    if (seen.has(c.id)) return fail(`contact ${c.id} appears twice in the file named by input 'contacts_path'`)
    seen.add(c.id)
  }

  const { outbox, review_tasks, stop } = planOutbox(contacts, steps, replied, stored, new Date())

  const body = JSON.stringify({ outbox, review_tasks })
  // ponytail: a named failure, not truncation. Truncating would starve: the
  // same first contacts would fill every run. A paged outbox is the upgrade.
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_BODY_CAP_BYTES) {
    return fail(`the outbox exceeds the ${OUTPUT_BODY_CAP_BYTES}-byte Output cap — approve and send what is due first, or split contacts across files`)
  }
  return skillOk(`${manifest.name}: ${outbox.length} emails due, ${review_tasks.length} review tasks, ${stop.length} contacts stopped`, {
    phases_completed: [manifest.name],
    artifacts_produced: [{ type: 'outbox', format: 'json', body }],
  })
}
