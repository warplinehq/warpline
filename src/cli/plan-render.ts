/**
 * `warpline plan`'s renderer — a pure model → string transform.
 *
 * Two shape rules that look like missing features and are not:
 *
 *   1. **No ANSI escapes, ever.** Byte-identical output and TTY-conditional
 *      colour are mutually exclusive: a piped run and a terminal run would
 *      differ, and CI would pin whichever one it happened to take. The
 *      approved/unapproved distinction is therefore carried by a glyph *plus*
 *      words, which survive a pager and a `| cat`. Plain text is also what
 *      pastes into the README demo; escape sequences are not.
 *
 *   2. **No width-aligned columns.** An indented tree puts each side effect on
 *      its own line one level under its plugin, so there is nothing to
 *      misalign. `board-cli.ts`'s column helper measures UTF-16 code units, so
 *      a wide CJK or astral-plane plugin name shifts every column on its row.
 *      Indentation dissolves that problem instead of solving it — do not
 *      "improve" this file by reintroducing aligned columns.
 *
 * The function returns a string and prints nothing, and every time-derived
 * value comes from the injected `now`. It sorts the standing grants it is
 * given by nothing: the gate's listing is already ordered by next expiry, then
 * id, and a second sort here would be a second owner of that order. Reading the wall clock here
 * would break byte identity the moment two renders straddled a minute
 * boundary — which is exactly the guarantee this command sells.
 */
import type { LoadFailure, NotDueReason } from '../runtime/engine.js'

// ── Model ──

/** A plugin the next run would attempt, with its declared side effects. */
export interface PlanEntry {
  plugin: string
  /** `topoSort` dependency level — 0 runs first. */
  level: number
  /** Declared side effects in manifest declaration order, never re-sorted. */
  sideEffects: string[]
  /**
   * Live approval state for this plugin. From `checkApproval` for a
   * session-class plugin. For a content-class plugin it is the approval's
   * standing, and true on an entry carrying a `condition`.
   */
  approved: boolean
  /**
   * Present and `true` only when the manifest declares `llm_handoff: true`,
   * absent otherwise. It means the plugin MAY hand judgment to the LLM, not
   * that this run will.
   */
  llmHandoff?: boolean
  /**
   * Present only when the preview lists the plugin as due on a condition it
   * cannot check, and absent otherwise, so every other entry renders
   * byte-identically.
   */
  condition?: string
}

/**
 * A plugin the next run would skip, with the reason the evaluator returned.
 *
 * Carries side effects and approval state for the same reason `PlanEntry`
 * does: `checkApproval` is the LAST guard in the chain, so a plugin blocked by
 * the gate is *not due*, and the `⚠ unapproved` marker would be unreachable if
 * only the due section rendered side effects. The effects are exactly the point
 * of that skip, so they render beneath it.
 */
export interface NotDueEntry {
  plugin: string
  level: number
  reason: NotDueReason
  detail: string
  sideEffects: string[]
  approved: boolean
  /**
   * Present and `true` only when the manifest declares `llm_handoff: true`,
   * absent otherwise. It means the plugin MAY hand judgment to the LLM, not
   * that this run will.
   */
  llmHandoff?: boolean
}

/** The live session grant, as read (never written) from the approval file. */
export interface GrantState {
  scopes: '*' | string[]
  /** Epoch milliseconds. */
  expiresAt: number
}

/** One standing grant as listed by the gate. Ids, names and times only, never a key. */
export interface StandingLine {
  id: string
  holder: string
  issuer: string
  scopes: string[]
  /** Epoch milliseconds: the earlier of the renewal deadline and the hard maximum. */
  nextExpiry: number
  state: 'live' | 'lapsed'
  /** The lapse reason, null when live. */
  reason: string | null
}

/** The standing grants file as read, or the fact that it could not be. */
export type StandingView = { readable: false } | { readable: true; grants: StandingLine[] }

export interface PlanModel {
  /** Resolved plugins directory — named in the no-plugins state. */
  pluginsDir: string
  /** The live session grant. Absent when no live grant exists. */
  grant?: GrantState
  /**
   * Absent or readable-and-empty: no standing section. Unreadable: one fixed
   * line, never an absent section, because could not look is not none.
   */
  standing?: StandingView
  due: PlanEntry[]
  notDue: NotDueEntry[]
  failures: LoadFailure[]
  /** Plugins in a dependency cycle, in `topoSort` report order. */
  cycle?: string[]
}

export type { LoadFailure }

// ── Formatting ──

const INDENT = '  '
const SUB_INDENT = '    '

/**
 * "may" is deliberate: a declaring plugin can still return `success`, and a
 * preview must never over-state what a run will do.
 */
const HANDOFF_LINE = `${SUB_INDENT}llm_handoff: may hand judgment to the LLM ([needs-llm])`

/** A grant this close to expiry earns a warning: the run may outlive it. */
const EXPIRES_SOON_MINUTES = 10

/** Codepoint order, not `localeCompare` — locale-dependent order is not stable. */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function byLevelThenName(
  a: { plugin: string; level: number },
  b: { plugin: string; level: number },
): number {
  return a.level !== b.level ? a.level - b.level : byCodepoint(a.plugin, b.plugin)
}

/**
 * The session grant header. One sentence shape: the none case gains the
 * standing clause exactly when the standing grants file was read and lists a
 * grant, live or lapsed. An unreadable file gets the plain sentence, because
 * its own line already says none is live.
 */
function grantLine(grant: GrantState | undefined, now: number, standingListed: boolean): string {
  if (!grant) {
    const none = 'Session grant: none — plugins with side effects would be SKIPPED this run'
    return standingListed ? `${none} unless a live standing grant covers them` : none
  }

  const scopes =
    grant.scopes === '*' ? 'all plugins (*)' : [...grant.scopes].sort(byCodepoint).join(', ')

  const remainingMs = grant.expiresAt - now
  if (remainingMs <= 0) return `Session grant: ${scopes} — expired`

  // Rounded DOWN: a grant with 59s left has 0 whole minutes of usable life,
  // and rounding up would advertise time the operator does not have.
  const minutes = Math.floor(remainingMs / 60_000)
  const soon = minutes <= EXPIRES_SOON_MINUTES ? ' ⚠ expires soon' : ''
  return `Session grant: ${scopes} — ${minutes}m remaining${soon}`
}

/**
 * A scope as visible text. The gate reads any non-empty scope from a
 * hand-edited file, so a control byte, C1 included, prints as `\xNN` and a
 * backslash doubles, never reaching the terminal as itself.
 */
const visible = (scope: string): string =>
  scope.replace(/[\\\x00-\x1f\x7f-\x9f]/g, (ch) =>
    ch === '\\' ? '\\\\' : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`,
  )

/** The standing section, in the order the model gives it. No cause is shown for an unreadable file. */
function standingLines(view: StandingView | undefined): string[] {
  if (view === undefined) return []
  if (!view.readable) return ['Standing grants: none live — the standing grants file cannot be read']
  if (view.grants.length === 0) return []
  return [
    `Standing grants (${view.grants.length}):`,
    ...view.grants.map(
      (g) =>
        `${INDENT}${g.id} — holder ${g.holder}, issuer ${g.issuer}, scopes ${g.scopes.map(visible).join(', ')} — next expiry ${new Date(g.nextExpiry).toISOString()} — ${g.state === 'live' ? 'live' : `lapsed (${g.reason})`}`,
    ),
  ]
}

function pluralDirectories(n: number): string {
  return n === 1 ? '1 plugin directory' : `${n} plugin directories`
}

/**
 * One line per declared side effect, one indent level under its plugin, in
 * manifest declaration order. Glyph plus words, never colour.
 */
function sideEffectLines(entry: { sideEffects: string[]; approved: boolean }): string[] {
  const marker = entry.approved ? '✓ approved' : '⚠ unapproved — would be SKIPPED this run'
  return entry.sideEffects.map((effect) => `${SUB_INDENT}${effect}: ${marker}`)
}

// ── Renderer ──

/**
 * Render a plan model as plain text.
 *
 * Section order is warnings first: an operator must see that the due-set is
 * incomplete before reading the due-set.
 */
export function renderPlan(model: PlanModel, now: number): string {
  const lines: string[] = []
  const totalFailure =
    model.failures.length > 0 && model.due.length === 0 && model.notDue.length === 0

  lines.push('warpline plan — preview only; nothing was executed.')
  lines.push('')
  const standingListed = model.standing?.readable === true && model.standing.grants.length > 0
  lines.push(grantLine(model.grant, now, standingListed))
  lines.push(...standingLines(model.standing))
  lines.push(`Plugins: ${model.pluginsDir}`)
  lines.push('')

  if (model.failures.length > 0) {
    lines.push(`Load failures (${model.failures.length}):`)
    lines.push('')
    for (const failure of model.failures) {
      lines.push(`${INDENT}${failure.plugin}: ${failure.error}`)
    }
    lines.push('')
    lines.push(
      totalFailure
        ? 'No plan could be computed — every plugin directory failed to load.'
        : `⚠ The due-set below is incomplete — ${pluralDirectories(model.failures.length)} could not be loaded.`,
    )
    lines.push('')
  }

  if (totalFailure) return lines.join('\n')

  if (model.cycle && model.cycle.length > 0) {
    lines.push('Dependency cycle — no plan could be computed:')
    lines.push('')
    for (const plugin of model.cycle) lines.push(`${INDENT}${plugin}`)
    lines.push('')
    return lines.join('\n')
  }

  if (model.due.length === 0 && model.notDue.length === 0) {
    lines.push('No plugins installed.')
    lines.push('')
    lines.push(`${INDENT}Create one with: warpline scaffold <plugin-name>`)
    lines.push('')
    return lines.join('\n')
  }

  if (model.due.length === 0) {
    lines.push('Nothing is due — no plugin passed the filter chain.')
    lines.push('')
  } else {
    lines.push(`Due (${model.due.length}):`)
    lines.push('')
    for (const entry of [...model.due].sort(byLevelThenName)) {
      lines.push(`${INDENT}${entry.plugin} (level ${entry.level})`)
      // Before the zero-effects branch, which ends the entry early.
      if (entry.llmHandoff === true) lines.push(HANDOFF_LINE)
      if (entry.condition !== undefined) lines.push(`${SUB_INDENT}${entry.condition}`)
      if (entry.sideEffects.length === 0) {
        lines.push(`${SUB_INDENT}(no declared side effects)`)
        continue
      }
      lines.push(...sideEffectLines(entry))
    }
    lines.push('')
  }

  // The not-due section is ALWAYS present once a plan was computed — an absent
  // section reads as "I did not check", which is the one thing a preview must
  // never imply. The three states with no plan at all returned above.
  if (model.notDue.length === 0) {
    lines.push('Not due: none — every plugin passed the filter chain.')
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`Not due (${model.notDue.length}):`)
  lines.push('')
  for (const entry of [...model.notDue].sort(byLevelThenName)) {
    lines.push(`${INDENT}${entry.plugin} — ${entry.detail}`)
    if (entry.llmHandoff === true) lines.push(HANDOFF_LINE)
    // Only the gate-blocked skip lists its effects: for every other reason
    // the effects are irrelevant noise, and this section is a summary.
    if (entry.reason === 'unapproved') lines.push(...sideEffectLines(entry))
  }
  lines.push('')

  return lines.join('\n')
}
