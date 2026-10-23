/**
 * pass — one consume pass, run by the `consume` verb, outside the engine.
 *
 * Nothing the engine imports reaches this directory. A pass never reads the
 * state document or its gate list: a Judgment is a file under the home, and
 * it opens no gate.
 *
 * A Handoff is live only while its record's state is `open`, and that state is
 * re-read under the record lock right before the Judgment is written. One try
 * runs in this order: the `handoff.reserved` line, the renderer call, the
 * `handoff.tried` line, the Judgment, then the record. The model writes
 * nothing: its text comes back as text, and this module writes it.
 *
 * Model calls run outside `.consume.lock` and outside the record lock. Only
 * the reservation and the settle take a lock. Every reason is a fixed phrase,
 * a key path or an errno code, never a configuration value.
 *
 * A pass that breaks a dead holder's claim reconciles what that holder left
 * before it tries. The holder's try is the latest reservation for the
 * Handoff that no try on the record names. When its `handoff.tried` says
 * `answered` and the file at `output_path` has the recorded sha256, the paid
 * answer is marked `recovered`, with no call and no reservation. Anything else
 * is that try appended as `failed`, with a `handoff.tried` written first when
 * the holder died before its own, and it counts against `consume.max_tries`.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { emitModelMismatch } from '../board/engine-events.js'
import { appendAudit, MODEL_ID, observeAuthorityFile } from '../lib/audit-log.js'
import { atomicWriteText } from '../lib/fs-atomic.js'
import { readHandoff, readOpenHandoffs, settleTry, type Handoff, type Try, type TryOutcome } from '../lib/handoffs.js'
import { engineStatePath, handoffsDir, preferencesPath, warplineHome } from '../lib/paths.js'
import { parseConsume, PreferencesInvalidError, readPreferencesFile, type ConsumeSettings } from '../lib/preferences.js'
import { claimHandoff, releaseClaim } from './claim.js'
import {
  CLAUDE_CLI_FLOOR,
  meetsFloor,
  parseCliVersion,
  probeClaudeVersion,
  renderClaudeCode,
  resolveClaudeBin,
} from './claude-code.js'
import { CONSUME_API_KEY_ENV, expectedOpenAiBasis, renderOpenAi } from './openai.js'
import { toMicroUp, type CostBasis, type Rendered } from './renderers.js'
import { CONSUME_LOCK_NAME, reserve, unsettledReservation, type TriedLine } from './spend.js'

type Entry = { id: string; reason: string }

export type PassResult = {
  answered: string[]
  failed: Entry[]
  refused: Entry[]
  skipped: Entry[]
  discarded: string[]
  /** A Handoff whose claim another live consumer holds. */
  held: string[]
  unreadable: string[]
  /** A Handoff whose try was served another model, and whose board notice could not be written. */
  unannounced: string[]
  /** Why the pass could not run at all, or null. */
  refusal: string | null
}

type Env = Readonly<Record<string, string | undefined>>

/** 0 only when nothing needs eyes: no pass refusal and no failed, refused, skipped, discarded, unreadable or unannounced entry. */
export function exitCodeFor(r: PassResult): 0 | 1 {
  const quiet =
    r.refusal === null &&
    r.failed.length === 0 &&
    r.refused.length === 0 &&
    r.skipped.length === 0 &&
    r.discarded.length === 0 &&
    r.unreadable.length === 0 &&
    r.unannounced.length === 0
  return quiet ? 0 : 1
}

const errnoOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

/** What the renderer switch needs, set up once per pass, keyed by the closed renderer setting. */
type Setup =
  | { renderer: Extract<ConsumeSettings['renderer'], 'claude-code'>; bin: string }
  | { renderer: Extract<ConsumeSettings['renderer'], 'openai-compatible'>; endpoint: string; apiKey: string | null }

/** The one renderer switch. The setting is a closed enum, so an unhandled arm fails to compile. */
function render(setup: Setup, o: { model: string; prompt: string; capMicro: number | null; settings: ConsumeSettings; parentEnv: Env }): Promise<Rendered> {
  switch (setup.renderer) {
    case 'claude-code':
      return renderClaudeCode({ bin: setup.bin, model: o.model, prompt: o.prompt, capMicro: o.capMicro, parentEnv: o.parentEnv })
    case 'openai-compatible':
      return renderOpenAi({ endpoint: setup.endpoint, model: o.model, prompt: o.prompt, apiKey: setup.apiKey, prices: o.settings.prices })
    default: {
      const unhandled: never = setup
      throw new Error(`unhandled renderer ${String(unhandled)}`)
    }
  }
}

/** A `handoff.tried` append the store refused: the settle writes nothing. */
class TryNotRecorded extends Error {}

/**
 * Append the `handoff.tried` line for one try, then return the try the record
 * gets. The only emit site of the kind. A refused append throws
 * `TryNotRecorded`, so the caller's effect does not happen.
 */
async function recordTry(
  statePath: string,
  id: string,
  reservationId: string,
  outcome: Exclude<TryOutcome, 'recovered'>,
  requested: string,
  served: string | null,
  rendered: Rendered,
  textBytes: Buffer | null,
  now: () => number,
  reason: string | null,
): Promise<Try> {
  try {
    await appendAudit(statePath, 'handoff.tried', {
      reservation_id: reservationId,
      handoff: id,
      outcome,
      requested,
      served,
      cost_micro_usd: rendered.cost_micro_usd,
      cost_basis: rendered.cost_basis,
      bytes: textBytes === null ? null : textBytes.length,
      sha256: textBytes === null ? null : createHash('sha256').update(textBytes).digest('hex'),
    })
  } catch {
    throw new TryNotRecorded()
  }
  return {
    at: new Date(now()).toISOString(),
    reservation_id: reservationId,
    requested,
    served,
    cost_micro_usd: rendered.cost_micro_usd,
    cost_basis: rendered.cost_basis,
    outcome,
    reason,
  }
}

/** The largest context file a try sends. Under the claude CLI's 10 MB stdin cap, so a prompt is never cut there. */
export const CONTEXT_MAX_BYTES = 8 * 1024 * 1024

const OUTSIDE_OUTPUT = 'output_path resolves outside the home'

/** `p` through every link, when that lands on the home or below it; null when it lands elsewhere. Throws as `realpath` does. */
async function resolveInside(home: string, p: string): Promise<string | null> {
  const [h, r] = await Promise.all([realpath(home), realpath(p)])
  return r === h || r.startsWith(h + sep) ? r : null
}

/**
 * The context file's text, or a fixed reason. A relative path joins the home
 * and an absolute one is used as written; either way the file is read only
 * through its real path, and only when that is inside the home's.
 */
async function readContext(home: string, contextPath: string | null): Promise<{ text: string | null } | { reason: string }> {
  if (contextPath === null) return { text: null }
  let real: string | null
  try {
    real = await resolveInside(home, isAbsolute(contextPath) ? contextPath : join(home, contextPath))
  } catch (err) {
    return { reason: errnoOf(err) === 'ENOENT' ? 'the context file is missing' : `the context file could not be read (${errnoOf(err)})` }
  }
  if (real === null) return { reason: 'the context path resolves outside the home' }
  let bytes: Buffer
  try {
    const fh = await open(real, 'r')
    try {
      if ((await fh.stat()).size > CONTEXT_MAX_BYTES) return { reason: 'the context file is over 8 MiB' }
      bytes = await fh.readFile()
    } finally {
      await fh.close()
    }
  } catch (err) {
    return { reason: `the context file could not be read (${errnoOf(err)})` }
  }
  // Grown since the stat: the bound is on what is sent.
  if (bytes.length > CONTEXT_MAX_BYTES) return { reason: 'the context file is over 8 MiB' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  } catch {
    return { reason: 'the context file is not UTF-8' }
  }
}

/**
 * The Judgment's absolute path with its directory made, or a fixed reason.
 * The deepest existing ancestor must resolve inside the home before anything
 * is made, so a link out of the home never gets a directory made through it,
 * and the made directory is checked again.
 */
async function prepareOutput(home: string, outputPath: string): Promise<{ target: string } | { reason: string }> {
  const target = join(home, outputPath)
  const parent = dirname(target)
  try {
    let ancestor = parent
    for (;;) {
      try {
        if ((await resolveInside(home, ancestor)) === null) return { reason: OUTSIDE_OUTPUT }
        break
      } catch (err) {
        if (errnoOf(err) !== 'ENOENT' || dirname(ancestor) === ancestor) throw err
        ancestor = dirname(ancestor)
      }
    }
    await mkdir(parent, { recursive: true })
    if ((await resolveInside(home, parent)) === null) return { reason: OUTSIDE_OUTPUT }
  } catch (err) {
    return { reason: `the output directory could not be made (${errnoOf(err)})` }
  }
  return { target }
}

/** Why a renderer's text is not an answer, or null when it is. */
function textProblem(text: string, maxBytes: number): string | null {
  if (text.trim() === '') return 'the text was empty'
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) return 'the text is over consume.max_output_bytes'
  return null
}

/** The tries counted against `consume.max_tries`: every one not answered, recovered or discarded. */
function countedTries(h: Handoff): number {
  return (h.tries ?? []).filter((t) => t.outcome !== 'answered' && t.outcome !== 'recovered' && t.outcome !== 'discarded').length
}

const MAX_TRIES_USED = 'the Handoff has used consume.max_tries tries'

const MISMATCH_REFUSED = 'the served model differs from the requested one'

const STOPPED = 'the consumer holding the claim stopped'

const CLOSED_DURING = 'the Handoff closed before the try ended'

/** The sha256 of the file at `p` when it resolves inside the home, or null when it is missing, outside or unreadable. */
async function shaInside(home: string, p: string): Promise<string | null> {
  try {
    const real = await resolveInside(home, p)
    return real === null ? null : createHash('sha256').update(await readFile(real)).digest('hex')
  } catch {
    return null
  }
}

const basisOf = (b: string): CostBasis => (b === 'reported' || b === 'computed' ? b : 'unknown')

/** The record's try for a stopped holder's `handoff.tried` line, with the outcome and reason given. */
const mirrorTry = (reservationId: string, t: TriedLine, outcome: TryOutcome, reason: string | null, at: number): Try => ({
  at: new Date(at).toISOString(),
  reservation_id: reservationId,
  requested: t.requested,
  served: t.served,
  cost_micro_usd: t.cost_micro_usd,
  cost_basis: basisOf(t.cost_basis),
  outcome,
  reason,
})

/** Answer the open Handoff records once, oldest first. `plugins` null means every plugin. */
export async function consumePass(o: {
  plugins: readonly string[] | null
  parentEnv: Env
  now?: () => number
}): Promise<PassResult> {
  const now = o.now ?? Date.now
  const result: PassResult = {
    answered: [],
    failed: [],
    refused: [],
    skipped: [],
    discarded: [],
    held: [],
    unreadable: [],
    unannounced: [],
    refusal: null,
  }
  const refuse = (refusal: string): PassResult => ({ ...result, refusal })
  const dir = handoffsDir()
  const statePath = engineStatePath()

  // 1. The open records.
  let listed: Awaited<ReturnType<typeof readOpenHandoffs>>
  try {
    listed = await readOpenHandoffs(dir)
  } catch (err) {
    return refuse(`the handoffs directory could not be listed (${errnoOf(err)})`)
  }
  result.unreadable = listed.unreadable
  const open = o.plugins === null ? listed.open : listed.open.filter((h) => o.plugins!.includes(h.plugin))
  if (open.length === 0) return result

  // 2. The preferences, read once and put on the audit record before use.
  let settings: ConsumeSettings
  try {
    const { prefs, bytes } = await readPreferencesFile(preferencesPath())
    try {
      await observeAuthorityFile(statePath, 'preferences.observed', bytes)
    } catch {
      return refuse('the audit store could not record the preferences read')
    }
    const parsed = parseConsume(prefs.consume)
    if ('unusable' in parsed) return refuse(`consume settings are unusable at ${parsed.unusable}`)
    settings = parsed.consume
  } catch (err) {
    if (err instanceof PreferencesInvalidError) return refuse(`preferences.json is unusable: ${err.reason}`)
    return refuse(`preferences.json could not be read (${errnoOf(err)})`)
  }

  // 3. The renderer, set up once.
  let setup: Setup
  if (settings.renderer === 'claude-code') {
    const bin = resolveClaudeBin(o.parentEnv.PATH)
    if (bin === null) return refuse('claude was not found on PATH')
    const version = await probeClaudeVersion(bin, o.parentEnv)
    if (version === null) return refuse('claude did not report a version')
    if (!meetsFloor(version)) {
      const v = parseCliVersion(version)
      return refuse(
        v === null ? 'claude did not report a version' : `claude ${v.join('.')} is below the floor ${CLAUDE_CLI_FLOOR}`,
      )
    }
    setup = { renderer: 'claude-code', bin }
  } else {
    if (settings.endpoint === undefined) return refuse('consume.endpoint is not set')
    setup = { renderer: 'openai-compatible', endpoint: settings.endpoint, apiKey: o.parentEnv[CONSUME_API_KEY_ENV] ?? null }
  }

  const capPerCallMicro = settings.max_usd_per_call === undefined ? null : toMicroUp(settings.max_usd_per_call)
  const capWindowMicro = settings.max_usd_per_window === undefined ? null : toMicroUp(settings.max_usd_per_window)
  const capped = capPerCallMicro !== null || capWindowMicro !== null

  // 4. Each open record.
  for (const h of open) {
    const id = h.id
    // Refusals that need no claim add no try.
    const requested = settings.models[h.plugin] ?? settings.model
    if (requested === undefined) {
      result.refused.push({ id, reason: 'consume.model is not set' })
      continue
    }
    const outputPath = h.output_path
    if (outputPath === undefined || outputPath === null) {
      result.refused.push({ id, reason: 'the Handoff names no output_path' })
      continue
    }
    const basis: CostBasis = setup.renderer === 'claude-code' ? 'reported' : expectedOpenAiBasis(requested, settings.prices)
    if (capped && basis === 'unknown') {
      result.refused.push({ id, reason: 'no cost basis under a spend cap: the model has no consume.prices entry' })
      continue
    }
    if (countedTries(h) >= settings.max_tries) {
      result.skipped.push({ id, reason: MAX_TRIES_USED })
      continue
    }

    const claimed = claimHandoff(dir, id)
    if (!claimed.claimed) {
      if (claimed.why === 'held') result.held.push(id)
      else result.refused.push({ id, reason: 'claimed by a consumer this host cannot judge' })
      continue
    }
    try {
      let current: Handoff | null
      try {
        current = await readHandoff(dir, h.run_id, h.plugin)
      } catch {
        result.unreadable.push(`${id}.json`)
        continue
      }
      // Answered after the listing: another consumer finished it, and there is nothing to do.
      if (current?.state === 'answered') continue
      if (current === null || current.state !== 'open') {
        result.skipped.push({ id, reason: 'the Handoff is no longer open' })
        continue
      }

      const home = warplineHome()
      let counted = countedTries(current)

      // A dead holder's claim was broken: settle what it left before any try.
      if (claimed.broke) {
        let dead: Awaited<ReturnType<typeof unsettledReservation>>
        try {
          dead = await unsettledReservation(statePath, id, new Set((current.tries ?? []).map((t) => t.reservation_id)))
        } catch {
          result.refused.push({ id, reason: 'the audit store could not be read for the stopped consumer' })
          continue
        }
        if (dead !== null) {
          const { reservationId, tried } = dead
          const paid =
            tried !== null &&
            tried.outcome === 'answered' &&
            tried.sha256 !== null &&
            (await shaInside(home, join(home, outputPath))) === tried.sha256
          // The holder's own try, as `outcome`. With no `handoff.tried` from it, one is written first.
          const deadTry = (outcome: Exclude<TryOutcome, 'recovered'>): Promise<Try> =>
            tried === null
              ? recordTry(
                  statePath,
                  id,
                  reservationId,
                  outcome,
                  requested,
                  null,
                  { ok: false, text: null, served: null, cost_micro_usd: null, cost_basis: 'unknown', reason: STOPPED },
                  null,
                  now,
                  STOPPED,
                )
              : Promise.resolve(mirrorTry(reservationId, tried, outcome, STOPPED, now()))
          let settled: { state: string; try: Try }
          try {
            settled = paid
              ? await settleTry(
                  dir,
                  id,
                  async () => ({ try: mirrorTry(reservationId, tried!, 'recovered', null, now()), close: true }),
                  async () => mirrorTry(reservationId, tried!, 'discarded', CLOSED_DURING, now()),
                  now(),
                )
              : await settleTry(
                  dir,
                  id,
                  async () => {
                    const o = tried?.outcome
                    return { try: await deadTry(o === 'refused' || o === 'discarded' ? o : 'failed'), close: false }
                  },
                  () => deadTry('discarded'),
                  now(),
                )
          } catch (err) {
            if (err instanceof TryNotRecorded) result.refused.push({ id, reason: 'the audit store could not record the try' })
            else result.failed.push({ id, reason: `the try could not be settled (${errnoOf(err)})` })
            continue
          }
          if (settled.try.outcome === 'recovered') {
            result.answered.push(id)
            continue
          }
          if (settled.state !== 'open') {
            result.discarded.push(id)
            continue
          }
          if (settled.try.outcome !== 'discarded') counted += 1
        }
      }

      // Re-read under the claim: another consumer may have spent the last try since the listing.
      if (counted >= settings.max_tries) {
        result.skipped.push({ id, reason: MAX_TRIES_USED })
        continue
      }
      const context = await readContext(home, current.context_path)
      if ('reason' in context) {
        result.refused.push({ id, reason: context.reason })
        continue
      }
      const prompt = context.text === null ? current.task : `${current.task}\n\n${context.text}`
      const output = await prepareOutput(home, outputPath)
      if ('reason' in output) {
        result.refused.push({ id, reason: output.reason })
        continue
      }
      const target = output.target

      let reservationId: string
      try {
        const r = await reserve({
          statePath,
          lockPath: join(dir, CONSUME_LOCK_NAME),
          handoff: id,
          capPerCallMicro,
          capWindowMicro,
          windowSeconds: settings.window_seconds,
          now,
        })
        if (!r.reserved) {
          result.refused.push({ id, reason: r.reason })
          continue
        }
        reservationId = r.reservationId
      } catch {
        result.refused.push({ id, reason: 'the audit store could not record the reservation' })
        continue
      }

      const rendered = await render(setup, {
        model: requested,
        prompt,
        capMicro: capPerCallMicro,
        settings,
        parentEnv: o.parentEnv,
      })
      const served = rendered.served !== null && MODEL_ID.test(rendered.served) ? rendered.served : null
      const textBytes = rendered.text === null ? null : Buffer.from(rendered.text, 'utf-8')
      // Exact inequality, and no reported model counts. A call that returned no text served nothing to compare.
      const mismatch = rendered.ok && rendered.text !== null && served !== requested
      const tryOf = (outcome: Exclude<TryOutcome, 'recovered'>, reason: string | null) =>
        recordTry(statePath, id, reservationId, outcome, requested, served, rendered, textBytes, now, reason)

      let settled: { state: string; try: Try }
      try {
        settled = await settleTry(
          dir,
          id,
          async () => {
            if (rendered.ok && rendered.text !== null) {
              if (mismatch && settings.model_mismatch === 'refuse') return { try: await tryOf('refused', MISMATCH_REFUSED), close: false }
              const problem = textProblem(rendered.text, settings.max_output_bytes)
              if (problem !== null) return { try: await tryOf('failed', problem), close: false }
              // Checked again at write time: the directory may have been swapped for a link out during the call.
              let inside: boolean
              try {
                inside = (await resolveInside(home, dirname(target))) !== null
              } catch (err) {
                return { try: await tryOf('failed', `the output directory could not be resolved (${errnoOf(err)})`), close: false }
              }
              if (!inside) return { try: await tryOf('failed', OUTSIDE_OUTPUT), close: false }
              const t = await tryOf('answered', null)
              await atomicWriteText(target, rendered.text)
              return { try: t, close: true }
            }
            return { try: await tryOf('failed', rendered.reason), close: false }
          },
          () => tryOf('discarded', 'the Handoff closed before the try ended'),
          now(),
        )
      } catch (err) {
        if (err instanceof TryNotRecorded) result.refused.push({ id, reason: 'the audit store could not record the try' })
        else result.failed.push({ id, reason: `the try could not be settled (${errnoOf(err)})` })
        continue
      }
      if (mismatch) {
        try {
          await emitModelMismatch(h.plugin, id, requested, served)
        } catch {
          result.unannounced.push(id)
        }
      }
      if (settled.try.outcome === 'answered') result.answered.push(id)
      else if (settled.try.outcome === 'discarded') result.discarded.push(id)
      else if (settled.try.outcome === 'refused') result.refused.push({ id, reason: settled.try.reason ?? MISMATCH_REFUSED })
      else result.failed.push({ id, reason: settled.try.reason ?? 'the renderer failed' })
    } finally {
      releaseClaim(dir, id, claimed.token)
    }
  }
  return result
}
