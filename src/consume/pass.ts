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
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
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
import { CONSUME_LOCK_NAME, reserve } from './spend.js'

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
  /** Why the pass could not run at all, or null. */
  refusal: string | null
}

type Env = Readonly<Record<string, string | undefined>>

/** 0 only when nothing needs eyes: no pass refusal and no failed, refused, skipped, discarded or unreadable entry. */
export function exitCodeFor(r: PassResult): 0 | 1 {
  const quiet =
    r.refusal === null &&
    r.failed.length === 0 &&
    r.refused.length === 0 &&
    r.skipped.length === 0 &&
    r.discarded.length === 0 &&
    r.unreadable.length === 0
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

/** The prompt: the task, or the task, a blank line and the context file's text. */
async function promptOf(h: Handoff): Promise<string> {
  if (h.context_path === null) return h.task
  const path = isAbsolute(h.context_path) ? h.context_path : join(warplineHome(), h.context_path)
  return `${h.task}\n\n${await readFile(path, 'utf-8')}`
}

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

      let prompt: string
      try {
        prompt = await promptOf(current)
      } catch (err) {
        result.refused.push({ id, reason: `the context file could not be read (${errnoOf(err)})` })
        continue
      }

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
      const tryOf = (outcome: Exclude<TryOutcome, 'recovered'>, reason: string | null) =>
        recordTry(statePath, id, reservationId, outcome, requested, served, rendered, textBytes, now, reason)

      let settled: { state: string; try: Try }
      try {
        settled = await settleTry(
          dir,
          id,
          async () => {
            if (rendered.ok && rendered.text !== null) {
              const t = await tryOf('answered', null)
              await atomicWriteText(join(warplineHome(), outputPath), rendered.text)
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
      if (settled.try.outcome === 'answered') result.answered.push(id)
      else if (settled.try.outcome === 'discarded') result.discarded.push(id)
      else result.failed.push({ id, reason: settled.try.reason ?? 'the renderer failed' })
    } finally {
      releaseClaim(dir, id, claimed.token)
    }
  }
  return result
}
