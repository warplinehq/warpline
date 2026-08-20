/**
 * `warpline plan`'s renderer — a pure model → string transform (D-21).
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
 * value comes from the injected `now` (D-19). Reading the wall clock here
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
  /** Live approval state for this plugin, from `checkApproval`. */
  approved: boolean
}

/** A plugin the next run would skip, with the reason the evaluator returned. */
export interface NotDueEntry {
  plugin: string
  level: number
  reason: NotDueReason
  detail: string
}

/** The live session grant, as read (never written) from the approval file. */
export interface GrantState {
  scopes: '*' | string[]
  /** Epoch milliseconds. */
  expiresAt: number
}

export interface PlanModel {
  /** Resolved plugins directory — named in the no-plugins state. */
  pluginsDir: string
  /** Absent when no live grant exists. */
  grant?: GrantState
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

function grantLine(grant: GrantState | undefined, now: number): string {
  if (!grant) {
    return 'Grant: none — plugins with side effects would be SKIPPED this run'
  }

  const scopes =
    grant.scopes === '*' ? 'all plugins (*)' : [...grant.scopes].sort(byCodepoint).join(', ')

  const remainingMs = grant.expiresAt - now
  if (remainingMs <= 0) return `Grant: ${scopes} — expired`

  // Rounded DOWN: a grant with 59s left has 0 whole minutes of usable life,
  // and rounding up would advertise time the operator does not have.
  const minutes = Math.floor(remainingMs / 60_000)
  const soon = minutes <= EXPIRES_SOON_MINUTES ? ' ⚠ expires soon' : ''
  return `Grant: ${scopes} — ${minutes}m remaining${soon}`
}

function pluralDirectories(n: number): string {
  return n === 1 ? '1 plugin directory' : `${n} plugin directories`
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
  lines.push(grantLine(model.grant, now))
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
      if (entry.sideEffects.length === 0) {
        lines.push(`${SUB_INDENT}(no declared side effects)`)
        continue
      }
      const marker = entry.approved
        ? '✓ approved'
        : '⚠ unapproved — would be SKIPPED this run'
      for (const effect of entry.sideEffects) {
        lines.push(`${SUB_INDENT}${effect}: ${marker}`)
      }
    }
    lines.push('')
  }

  if (model.notDue.length > 0) {
    lines.push(`Not due (${model.notDue.length}):`)
    lines.push('')
    for (const entry of [...model.notDue].sort(byLevelThenName)) {
      lines.push(`${INDENT}${entry.plugin} — ${entry.detail}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
