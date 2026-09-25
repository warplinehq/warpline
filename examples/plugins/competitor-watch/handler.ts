import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { OUTPUT_BODY_CAP_BYTES, makeSkillError, type SkillError } from 'warpline/schemas/skill-result'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Own state, `<home>/state/competitor-watch.last.json`: the normalised text
 * each declared target had the last time it was fetched, keyed by target.
 * { "https://...": "line one\nline two" }
 *
 * The Output body, one entry per declared target in declared order:
 * { "targets": [
 *   { "position": 1, "status": "changed", "diff": ["- old", "+ new"], "diff_truncated": false },
 *   { "position": 2, "status": "failed", "reason": "HTTP 500" }
 * ] }
 *
 * A target is named by its 1-based position and never by its URL. The URL is
 * a configured value, it can carry a token, and every field of the result
 * lands in a run log.
 */
interface Entry {
  position: number
  status: 'new' | 'changed' | 'unchanged' | 'failed'
  diff?: string[]
  diff_truncated?: boolean
  reason?: string
}

/** No diff line is reported longer than this, prefix included. */
const MAX_LINE_CHARS = 200

/**
 * The text a comparison is made over. Line endings become `\n`, each line is
 * trimmed and its inner whitespace runs collapse to one space, and empty
 * lines go. Markup is kept: this compares text, it does not parse pages, so a
 * body that differs only in its line endings or its spacing reads the same.
 */
export function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * The lines that differ between two normalised texts, as one hunk: the
 * common leading and trailing lines are dropped, and what is left of
 * `before` is emitted as `- ` lines, then what is left of `after` as `+ `
 * lines. Each line is cut to MAX_LINE_CHARS and at most `maxLines` are kept.
 * ponytail: one hunk between the first and last differing line, so two edits
 * far apart report everything between them; an LCS line diff is the upgrade
 * when multi-hunk reports matter.
 */
export function diffLines(before: string, after: string, maxLines: number): { lines: string[]; truncated: boolean } {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const all = [
    ...a.slice(start, endA).map((line) => `- ${line}`),
    ...b.slice(start, endB).map((line) => `+ ${line}`),
  ].map((line) => line.slice(0, MAX_LINE_CHARS))
  return { lines: all.slice(0, maxLines), truncated: all.length > maxLines }
}

/**
 * A configured value, or the manifest's own default when the caller left it
 * out. The runtime merges defaults before a handler is called; a host that
 * calls the handler directly may not, and the default lives in ONE place.
 */
function configured(manifest: PluginManifest, args: Record<string, unknown>, key: string): unknown {
  return args[key] !== undefined ? args[key] : manifest.inputs[key]?.default
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The shape this plugin writes: a plain record whose every value is a string. */
function isSnapshot(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((text) => typeof text === 'string')
}

type Fetched = { ok: true; text: string } | { ok: false; reason: string }

/**
 * One target, and nothing here throws past the abort case. The declared URL
 * is the only one fetched: no link in the body is read, and `redirect:
 * 'error'` refuses a hop to anywhere else. A reason is a status or a shape,
 * never the URL, because a fetch error's message embeds the request URL.
 */
async function fetchText(url: string, signal: AbortSignal): Promise<Fetched> {
  let res: Response
  try {
    res = await fetch(url, { signal, redirect: 'error', headers: { 'user-agent': 'warpline-example' } })
  } catch (err) {
    // An abort is the runtime's own timeout or cancellation, and it
    // classifies the run by the signal, so the rejection goes back untouched.
    if (signal.aborted) throw err
    return { ok: false, reason: 'request failed' }
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  try {
    return { ok: true, text: await res.text() }
  } catch (err) {
    if (signal.aborted) throw err
    return { ok: false, reason: 'body unreadable' }
  }
}

export const handler: CapabilityHandlerFn = async (manifest, args, signal, _capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }

  // No arm below quotes a configured value. Each names the input key, or a
  // position in `targets`, and the shape it wanted.
  const targets = configured(manifest, args, 'targets')
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every(isHttpUrl)) {
    return skillFailure('parse_error', `${manifest.name}: input 'targets' must be a non-empty list of http(s) URLs`, FAILED)
  }
  // The snapshot is keyed by target, so a repeated one would compare against
  // itself. Refused before any fetch, and located by position.
  const seen = new Map<string, number>()
  for (const [i, url] of targets.entries()) {
    const first = seen.get(url)
    if (first !== undefined) {
      return skillFailure('parse_error', `${manifest.name}: input 'targets' lists the same URL at positions ${first + 1} and ${i + 1}`, FAILED)
    }
    seen.set(url, i)
  }
  const maxDiffLines = configured(manifest, args, 'max_diff_lines')
  if (typeof maxDiffLines !== 'number' || !Number.isInteger(maxDiffLines) || maxDiffLines < 1) {
    return skillFailure('parse_error', `${manifest.name}: input 'max_diff_lines' must be a whole number of at least 1`, FAILED)
  }

  // What the last run saw. The path comes from the manifest name, never from
  // `args`. A null is a first run. A file that cannot be read, or that is not
  // the shape this plugin writes, is refused: reading it as empty would
  // report every target `new` and then overwrite it.
  const snapshotPath = join(warplineHome(), 'state', `${manifest.name}.last.json`)
  const unreadable = () =>
    skillFailure('parse_error', `${manifest.name}: the last snapshot is unreadable — refusing to compare against it`, FAILED)
  let raw: unknown
  try {
    raw = await readJsonOrNull<unknown>(snapshotPath)
  } catch {
    return unreadable()
  }
  if (raw !== null && !isSnapshot(raw)) return unreadable()
  // Null prototype, read with `Object.hasOwn`: the file is hand-editable, and
  // a key like `__proto__` or `constructor` must be data and nothing else.
  const prior: Record<string, string> = Object.create(null)
  if (raw !== null) for (const [url, text] of Object.entries(raw)) prior[url] = text

  const entries: Entry[] = []
  const next: Record<string, string> = Object.create(null)
  for (const [i, url] of targets.entries()) {
    const position = i + 1
    const fetched = await fetchText(url, signal)
    if (!fetched.ok) {
      entries.push({ position, status: 'failed', reason: fetched.reason })
      // A failed target keeps what the last good fetch saw.
      if (Object.hasOwn(prior, url)) next[url] = prior[url]!
      continue
    }
    const text = normalise(fetched.text)
    next[url] = text
    if (!Object.hasOwn(prior, url)) {
      entries.push({ position, status: 'new' })
    } else if (prior[url] === text) {
      entries.push({ position, status: 'unchanged' })
    } else {
      const { lines, truncated } = diffLines(prior[url]!, text, maxDiffLines)
      entries.push({ position, status: 'changed', diff: lines, diff_truncated: truncated })
    }
  }

  const failed = entries.filter((e) => e.status === 'failed')
  // Every target failing is a failure, and the snapshot is left as it was.
  if (failed.length === entries.length) {
    const reasons = failed.map((e) => `target ${e.position}: ${e.reason}`).join('; ')
    return skillFailure('dependency_unavailable', `${manifest.name}: every target failed (${reasons})`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
    })
  }

  // One inline Output, and the body cap is 16 KiB of UTF-8. Checked here, by
  // name, before the snapshot is written, so a report too big to keep does
  // not advance the baseline the next run compares against.
  const body = JSON.stringify({ targets: entries })
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_BODY_CAP_BYTES) {
    return skillFailure(
      'parse_error',
      `${manifest.name}: the report exceeds the ${OUTPUT_BODY_CAP_BYTES}-byte Output cap — lower max_diff_lines or declare fewer targets`,
      FAILED,
    )
  }

  // Only the declared targets are kept, so a target removed from the list
  // drops out of the snapshot.
  await atomicWriteJson(snapshotPath, next)

  const count = (status: Entry['status']) => entries.filter((e) => e.status === status).length
  const errors: SkillError[] = failed.map((e) =>
    makeSkillError('dependency_unavailable', `target ${e.position}: ${e.reason}`, { impact: 'MEDIUM', retryable: false }))
  return skillOk(
    `${manifest.name}: ${entries.length} targets — ${count('new')} new, ${count('changed')} changed, ${count('unchanged')} unchanged, ${failed.length} failed`,
    {
      phases_completed: [manifest.name],
      errors: errors.length > 0 ? errors : undefined,
      artifacts_produced: [{ type: 'report', format: 'json', body }],
    },
  )
}
