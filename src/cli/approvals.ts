/**
 * `warpline approvals` — what is waiting on a human, read from the terminal.
 *
 * Two forms. `warpline approvals` lists every open Ask that has not reached
 * its `expires_at`, `warning` before `info`, then oldest first, then by id.
 * `warpline approvals show <id>` prints one Ask, the content it is about, and
 * the diff from the last approved content when those bytes are still on disk.
 *
 * It reads `<home>/state/asks.json`, and for `show` the state document, the
 * plugin manifests and, for a renewal, the standing grants file. **It takes no
 * lock and writes nothing**, as `deny --list` does. A read that races an
 * advance sees the store before or after its atomic write, never half of it.
 *
 * **It never prints a nonce.** The nonce is the single-use token an Answer
 * presents, and it reaches an approver in the `notify` message. An operator
 * with no `notify` channel reads it from `<home>/state/asks.json`.
 *
 * **Every byte a plugin wrote goes through `escapeForOperator`**, the one copy
 * `approve --content` uses: control characters print as `\xNN`, escaped and
 * never stripped. A `path` Output prints its path and is never read: the Ask
 * binds the path string, not the file's bytes.
 *
 * **The diff baseline is only bytes still on disk.** For content, an inline
 * Output from the producer's applied gate markers or its current Output whose
 * fingerprint equals the one the content approval recorded. For a parked
 * result, the plugin's latest applied gate marker's inline Output. No copy of
 * approved bytes is ever kept to diff against, so the content erasure policy
 * is unchanged. Without a baseline it says `no earlier approved content`.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { askSeverity, asksPath, readAsks, type Ask } from '../lib/asks.js'
import { escapeForOperator } from '../lib/escape.js'
import { lineDiff } from '../lib/line-diff.js'
import { engineStatePath, pluginsDir } from '../lib/paths.js'
import { readStandingStore } from '../runtime/approval-gate.js'
import { denialFingerprint, loadPluginManifests } from '../runtime/engine.js'
import { readEngineStateReadOnly } from '../runtime/engine-state-store.js'
import type { EngineState, PendingGate } from '../schemas/engine-state.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'

const USAGE = `Usage: warpline approvals
       warpline approvals show <id>

Lists the Asks waiting on a human, warning before info, then oldest first.
show prints one Ask, the content it is about, and the diff from the last
approved content while those bytes are still on disk.

Takes no lock, writes nothing, and never prints a nonce.
`

const BEGIN = '==== begin content ===='
const END = '==== end content ===='

type StoredOutput = NonNullable<EngineState['plugin_runs'][string]['last_output']>

/** The bytes of one Output as text, or why there is no text to show. */
type Content = { text: string } | { note: string }

/**
 * A path Output is never read: the Ask binds `path:<string>`, not the file's
 * bytes, and the file may say something else, sit relative to another cwd, or
 * be a FIFO that never ends. Same reason `approve --content` refuses one (runtime-spec § 10).
 */
function contentOf(out: StoredOutput | undefined): Content {
  if (out === undefined) return { note: 'no Output on record' }
  if (out.erased_at !== undefined) {
    return { note: `its content was erased at ${out.erased_at} (sha256 ${out.body_sha256})` }
  }
  if (out.body !== undefined) return { text: out.body }
  return { note: `a path Output, not read: ${escapeForOperator(out.path!)}. This Ask binds the path, not the file's bytes` }
}

/** The applied gate markers of `plugin`, oldest first. */
const markersOf = (state: EngineState, plugin: string): PendingGate[] =>
  state.pending_gates.filter((g) => g.plugin === plugin && g.applied_at !== null)

/** An inline body still on disk, or null. Only inline bytes can be proven to be the ones approved. */
const inline = (out: StoredOutput | undefined): string | null =>
  out !== undefined && out.erased_at === undefined && out.body !== undefined ? out.body : null

/**
 * The content approval's bytes, when the producer still holds them: an inline
 * Output from its applied markers, or its current one, whose fingerprint
 * equals the one the approval recorded. Never a kept copy.
 */
function contentBaseline(
  state: EngineState,
  consumer: string,
  manifests: ReadonlyMap<string, PluginManifest>,
): string | null {
  const approval = Object.hasOwn(state.approvals, consumer) ? state.approvals[consumer] : undefined
  if (approval === undefined) return null
  const producer = manifests.get(approval.producer)
  if (producer === undefined) return null
  const candidates = [
    ...markersOf(state, approval.producer).flatMap((g) => g.plugin_result.artifacts_produced),
    state.plugin_runs[approval.producer]?.last_output,
  ]
  for (const out of candidates) {
    const body = inline(out)
    if (body === null || out === undefined) continue
    if (denialFingerprint(approval.producer, producer.side_effects, [out]) === approval.fingerprint) return body
  }
  return null
}

function printFields(a: Ask): void {
  process.stdout.write(
    `Ask ${a.id}\n` +
      `  kind      ${a.kind}\n` +
      `  scope     ${a.scope}\n` +
      `  plugin    ${a.plugin ?? 'none'}\n` +
      `  severity  ${askSeverity(a.kind)}\n` +
      `  state     ${a.state}\n` +
      `  raised    ${a.raised_at}\n` +
      `  expires   ${a.expires_at}\n` +
      `  digest    ${a.digest}\n` +
      `  summary   ${a.summary}\n`,
  )
}

function printContent(label: string, c: Content): void {
  if ('note' in c) {
    process.stdout.write(`${label}: ${c.note}\n`)
    return
  }
  process.stdout.write(`${label}:\n${BEGIN}\n${escapeForOperator(c.text)}\n${END}\n`)
}

function printDiff(baseline: string | null, current: Content): void {
  if (baseline === null) {
    process.stdout.write('no earlier approved content\n')
    return
  }
  if ('note' in current) {
    process.stdout.write('no diff: the content asked about has no inline bytes\n')
    return
  }
  process.stdout.write('diff from the last approved content:\n')
  for (const { op, line } of lineDiff(baseline, current.text)) {
    process.stdout.write(`${op}${escapeForOperator(line)}\n`)
  }
}

async function show(a: Ask): Promise<void> {
  printFields(a)
  const state = await readEngineStateReadOnly(engineStatePath())
  const { manifests } = await loadPluginManifests(pluginsDir())

  switch (a.kind) {
    case 'parked_result': {
      const plugin = a.plugin!
      const current = contentOf(state.plugin_runs[plugin]?.last_output)
      printContent('the parked result', current)
      printDiff(inline(markersOf(state, plugin).at(-1)?.plugin_result.artifacts_produced.at(-1)), current)
      return
    }
    case 'content': {
      const consumer = a.plugin!
      const producer = manifests.get(consumer)?.dependencies[0]
      const current: Content =
        producer === undefined
          ? { note: `${consumer} has no loaded manifest naming its producer` }
          : contentOf(state.plugin_runs[producer]?.last_output)
      printContent(producer === undefined ? 'the content' : `the content from ${producer}`, current)
      printDiff(contentBaseline(state, consumer, manifests), current)
      return
    }
    case 'missing_grant': {
      const manifest = manifests.get(a.plugin!)
      process.stdout.write(
        manifest === undefined
          ? `declared side effects: unknown, ${a.plugin} has no loaded manifest\n`
          : `declared side effects: ${manifest.side_effects.join(', ') || 'none'}\n`,
      )
      process.stdout.write('no earlier approved content\n')
      return
    }
    case 'renewal': {
      const read = await readStandingStore()
      const grant = read.readable ? read.store.grants.find((g) => g.id === a.scope) : undefined
      if (!read.readable) process.stdout.write(`the standing grants file cannot be read (${read.cause})\n`)
      else if (grant === undefined) process.stdout.write(`grant ${a.scope} is gone from the standing grants file\n`)
      else {
        process.stdout.write(
          `grant ${grant.id}\n` +
            `  holder        ${grant.holder}\n` +
            `  issuer        ${grant.issuer}\n` +
            `  scopes        ${grant.scopes.join(', ')}\n` +
            `  issued_at     ${grant.issued_at}\n` +
            `  period_start  ${grant.period_start}\n` +
            `  period_ms     ${grant.period_ms}\n` +
            `  hard_max_ms   ${grant.hard_max_ms}\n`,
        )
      }
      process.stdout.write('no earlier approved content\n')
      return
    }
  }
}

export async function run(argv: string[]): Promise<number> {
  const listing = argv.length === 0
  if (!listing && !(argv.length === 2 && argv[0] === 'show')) {
    process.stderr.write(USAGE)
    return 1
  }

  if (!listing && !/^[0-9a-f]{12}$/.test(argv[1]!)) {
    process.stderr.write(`approvals: '${escapeForOperator(argv[1]!)}' is not an Ask id. An Ask id is 12 lowercase hex.\n`)
    return 1
  }

  const statePath = engineStatePath()
  const read = await readAsks(statePath)
  if (!read.readable) {
    process.stderr.write(
      `approvals: ${asksPath(statePath)} cannot be read (${read.cause}). Nothing is ${listing ? 'listed' : 'shown'}.\n`,
    )
    return 1
  }

  if (!listing) {
    const ask = read.store.asks.find((a) => a.id === argv[1])
    if (ask === undefined) {
      process.stderr.write(`approvals: no Ask has id ${argv[1]}.\n`)
      return 1
    }
    await show(ask)
    return 0
  }

  const now = Date.now()
  const open = read.store.asks
    .filter((a) => a.state === 'open' && now < Date.parse(a.expires_at))
    .sort(
      (x, y) =>
        (askSeverity(x.kind) === 'warning' ? 0 : 1) - (askSeverity(y.kind) === 'warning' ? 0 : 1) ||
        Date.parse(x.raised_at) - Date.parse(y.raised_at) ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    )
  if (open.length === 0) {
    process.stdout.write('Nothing waiting.\n')
    return 0
  }
  for (const a of open) {
    process.stdout.write(
      `${a.id}  ${askSeverity(a.kind)}  ${a.kind}  ${a.scope}  raised ${a.raised_at}  ` +
        `expires ${a.expires_at}  digest ${a.digest.slice(0, 12)}\n`,
    )
  }
  return 0
}
