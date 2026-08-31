#!/usr/bin/env node
/**
 * Non-interactive board CLI — works in any shell including Claude Code.
 *
 * Commands:
 *   bun run src/cli/board-cli.ts status        — show pending notices + tasks
 *   bun run src/cli/board-cli.ts status --budget — status + API budget table
 *   bun run src/cli/board-cli.ts ack <id>      — acknowledge an event
 *   bun run src/cli/board-cli.ts ack-all       — acknowledge all visible events
 *   bun run src/cli/board-cli.ts defer <id> <duration> — defer (1h, 4h, 1d, 1w)
 *   bun run src/cli/board-cli.ts tasks         — show task board
 *   bun run src/cli/board-cli.ts done <id>     — mark task done
 *   bun run src/cli/board-cli.ts budget        — show API budget table
 *   bun run src/cli/board-cli.ts auto-ack-poll — ack prior-run poll notices
 *
 * Reads the state files the engine writes, and nothing else — there is no
 * second store for a board to fall out of sync with.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '../lib/paths.js'
import { readTasks, readEvents, readAcks, writeAcks, completeTask, deferTask } from '../board/state-manager.js'
import type { BoardEvent, Acknowledgements } from '../schemas/board.js'
import type { TaskDisplay } from '../schemas/engine-state.js'
import { resolveRunRef, describeRunRef } from '../runtime/run-log-store.js'
import { ApiBudgetTracker } from '../lib/api-budget.js'
import type { BudgetSnapshot } from '../lib/api-budget.js'

const VISIBLE_TYPES = new Set([
  'task_created', 'task_updated', 'task_completed', 'task_deferred',
  'error', 'notice',
])

// ── Formatting ──

function severityIcon(s: string): string {
  return s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : '🔵'
}

function typeLabel(t: string): string {
  switch (t) {
    case 'task_created':   return '+ TASK'
    case 'task_updated':   return '↻ UPDT'
    case 'task_completed': return '✓ DONE'
    case 'task_deferred':  return '⏸ DEFR'
    case 'error':          return '✗ ERR '
    case 'notice':         return 'ℹ NOTE'
    default:               return '  ····'
  }
}

function timeAgo(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function pad(s: string, w: number): string {
  return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w)
}

/**
 * The run an event names, when it names one. A run id whose log has aged out
 * says so rather than showing an id that resolves to nothing; an event emitted
 * outside any run shows nothing at all, because there is nothing to show.
 * Resolution goes through the shared helper so this rendering and any other
 * cannot drift apart.
 */
function runNote(runId: string | null): string {
  const ref = resolveRunRef(runId)
  switch (ref.kind) {
    case 'none': return ''
    case 'retained': return `  (run ${shortId(ref.run_id)})`
    case 'not_retained': return `  (${describeRunRef({ kind: 'not_retained', run_id: shortId(ref.run_id) })})`
  }
}

// ── Commands ──

async function status() {
  const [events, tasks, acks] = await Promise.all([readEvents(), readTasks(), readAcks()])

  // `Object.hasOwn`, not `in`: `acks` is a plain object, so `in` walks the
  // prototype chain and an `event_id` of `toString` or `constructor` would read
  // as already acknowledged and be hidden from the board forever. Not reachable
  // while `event_id` is `crypto.randomUUID()`, and it is the same class the
  // `denials` and `plugin_runs` records were converted for — leaving one record
  // on the old shape is how the next one gets written that way.
  const active = events
    .filter(e => VISIBLE_TYPES.has(e.type) && !Object.hasOwn(acks, e.event_id))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const pendingTasks = tasks.filter((t: TaskDisplay) => t.state === 'pending' || t.state === 'active')

  console.log()
  console.log('┌─────────────────────────────────────────────────────────────────┐')
  console.log('│  Warpline Board                                                  │')
  console.log('└─────────────────────────────────────────────────────────────────┘')
  console.log()

  // Notices
  console.log(`  📋 Notices (${active.length} pending)`)
  console.log()
  if (active.length === 0) {
    console.log('     No pending notices.')
  } else {
    console.log(`     ${'ID'.padEnd(10)} ${''.padEnd(2)} ${'Type'.padEnd(8)} ${'Age'.padEnd(8)} ${'Source'.padEnd(18)} Summary`)
    console.log(`     ${'─'.repeat(10)} ${'──'} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(30)}`)
    for (const e of active) {
      const id = shortId(e.event_id)
      const icon = severityIcon(e.severity)
      const type = pad(typeLabel(e.type), 8)
      const age = pad(timeAgo(e.timestamp), 8)
      const src = pad(e.source, 18)
      console.log(`     ${pad(id, 10)} ${icon} ${type} ${age} ${src} ${e.summary}${runNote(e.run_id)}`)
    }
  }

  console.log()

  // Tasks
  console.log(`  📌 Tasks (${pendingTasks.length} active)`)
  console.log()
  if (pendingTasks.length === 0) {
    console.log('     No active tasks.')
  } else {
    console.log(`     ${'ID'.padEnd(10)} ${''.padEnd(2)} ${'Mode'.padEnd(10)} ${'Age'.padEnd(8)} ${'Source'.padEnd(18)} Summary`)
    console.log(`     ${'─'.repeat(10)} ${'──'} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(18)} ${'─'.repeat(30)}`)
    for (const t of pendingTasks) {
      const id = shortId(t.task_id)
      const icon = severityIcon(t.severity)
      const mode = pad(t.age_badge ?? '📝', 10)
      const age = pad(timeAgo(t.created_at), 8)
      const src = pad(t.source_check, 18)
      console.log(`     ${pad(id, 10)} ${icon} ${mode} ${age} ${src} ${t.description}`)
    }
  }

  console.log()
  console.log('  Commands:')
  console.log('     warpline ack <id>            Acknowledge a notice')
  console.log('     warpline ack-all             Acknowledge all notices')
  console.log('     warpline defer <id> <1h|4h|1d|1w>  Defer a notice')
  console.log('     warpline done <id>           Mark a task done')
  console.log('     warpline tasks               Show task board only')
  console.log()
}

async function ack(id: string) {
  const [events, acks] = await Promise.all([readEvents(), readAcks()])
  const match = events.find(e => e.event_id.startsWith(id))
  if (!match) {
    console.log(`✗ No event found matching "${id}"`)
    process.exit(1)
  }
  acks[match.event_id] = { acknowledged_at: new Date().toISOString(), action_taken: 'acknowledge' }
  await writeAcks(acks)
  console.log(`✓ Acknowledged: ${match.summary}`)
}

async function ackAll() {
  const [events, acks] = await Promise.all([readEvents(), readAcks()])
  const active = events.filter(e => VISIBLE_TYPES.has(e.type) && !Object.hasOwn(acks, e.event_id))
  if (active.length === 0) {
    console.log('No pending notices to acknowledge.')
    return
  }
  for (const e of active) {
    acks[e.event_id] = { acknowledged_at: new Date().toISOString(), action_taken: 'acknowledge' }
  }
  await writeAcks(acks)
  console.log(`✓ Acknowledged ${active.length} notices`)
}

async function defer(id: string, duration: string) {
  const durations: Record<string, number> = {
    '1h': 3600000,
    '4h': 14400000,
    '1d': 86400000,
    '1w': 604800000,
  }
  const ms = durations[duration]
  if (!ms) {
    console.log(`✗ Invalid duration "${duration}". Use: 1h, 4h, 1d, 1w`)
    process.exit(1)
  }

  const [events, acks] = await Promise.all([readEvents(), readAcks()])
  const match = events.find(e => e.event_id.startsWith(id))
  if (!match) {
    console.log(`✗ No event found matching "${id}"`)
    process.exit(1)
  }

  const deferred_until = new Date(Date.now() + ms).toISOString()
  ;(acks as Record<string, unknown>)[match.event_id] = {
    acknowledged_at: new Date().toISOString(),
    action_taken: 'defer',
    deferred_until,
  }
  await writeAcks(acks)
  console.log(`✓ Deferred: ${match.summary} until ${new Date(Date.now() + ms).toLocaleString()}`)
}

async function showTasks() {
  const tasks = await readTasks()
  // readTasks() already returns sorted by priority
  const pending = tasks.filter((t: TaskDisplay) => t.state === 'pending' || t.state === 'active')

  console.log()
  console.log(`  📌 Task Board (${pending.length} active)`)
  console.log()
  if (pending.length === 0) {
    console.log('     No active tasks.')
  } else {
    for (const t of pending) {
      const id = shortId(t.task_id)
      const icon = severityIcon(t.severity)
      console.log(`  ${icon} [${id}] ${t.description}`)
      console.log(`     source: ${t.source_check}  |  age: ${t.age_badge}  |  state: ${t.state}`)
      console.log()
    }
  }
  console.log('  Commands:')
  console.log('     warpline done <id>    Mark a task done')
  console.log()
}

async function markDone(id: string) {
  const tasks = await readTasks()
  const match = tasks.find((t: TaskDisplay) => t.task_id.startsWith(id))
  if (!match) {
    console.log(`✗ No task found matching "${id}"`)
    process.exit(1)
  }
  await completeTask(match.task_id)
  console.log(`✓ Completed: ${match.description}`)
}

const API_BUDGET_PATH = join(stateDir(), 'api-budget.json')

async function showBudget() {
  let snap: BudgetSnapshot | null = null
  try {
    const raw = await readFile(API_BUDGET_PATH, 'utf-8')
    snap = JSON.parse(raw) as BudgetSnapshot
  } catch {
    console.log()
    console.log('  No budget data yet. Run the engine (runAdvance) first.')
    console.log()
    return
  }

  const tracker = ApiBudgetTracker.fromSnapshot(snap)
  const current = tracker.snapshot()

  const windowDate = new Date(current.window_start)
  const windowTime = windowDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  const fmtWindow = (s: number): string =>
    s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`
  console.log()
  console.log(
    `  API Budget (window: ${fmtWindow(current.domains[0]?.window_seconds ?? 3600)} from ${windowTime})`,
  )
  console.log()
  console.log(`  ${'Domain'.padEnd(18)} ${'Calls'.padStart(7)} ${'Limit'.padStart(7)} ${'Remaining'.padStart(11)} ${'Utilisation'.padStart(12)}`)
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(11)} ${'─'.repeat(12)}`)

  for (const d of current.domains) {
    const pct = d.max_per_window > 0
      ? Math.round((d.calls_this_window / d.max_per_window) * 100)
      : 0
    const name = d.domain.padEnd(18)
    const calls = String(d.calls_this_window).padStart(7)
    const limit = String(d.max_per_window).padStart(7)
    const remaining = String(d.remaining).padStart(11)
    const util = `${pct}%`.padStart(12)
    console.log(`  ${name} ${calls} ${limit} ${remaining} ${util}`)
  }
  console.log()
}

// ── Router ──

const [cmd, ...args] = process.argv.slice(2)

/**
 * This file is not dispatcher-routed — it is its own process entry and exits
 * on its own — so it needs its own mapping for an unusable engine-state
 * document. `readEngineState` throws `EngineStateInvalidError` rather than
 * handing back defaults a later write would persist over the task board, and
 * `readTasks` is a write-capable read, so every command below can raise it.
 *
 * Duck-typed on `err.name` for the same reason `src/cli/warpline.ts` is:
 * catching it by name needs no import at all.
 */
try {
  switch (cmd) {
    case 'status':
    case undefined:
      await status()
      if (args.includes('--budget')) await showBudget()
      break
    case 'ack':
      if (!args[0]) { console.log('Usage: warpline ack <event-id-prefix>'); process.exit(1) }
      await ack(args[0])
      break
    case 'ack-all':
      await ackAll()
      break
    case 'defer':
      if (!args[0] || !args[1]) { console.log('Usage: warpline defer <event-id-prefix> <1h|4h|1d|1w>'); process.exit(1) }
      await defer(args[0], args[1])
      break
    case 'tasks':
      await showTasks()
      break
    case 'done':
      if (!args[0]) { console.log('Usage: warpline done <task-id-prefix>'); process.exit(1) }
      await markDone(args[0])
      break
    case 'budget':
      await showBudget()
      break
    case 'auto-ack-poll': {
      // Acknowledge all poll-type notices (stage changes, comments) from prior runs.
      // Only acks 'notice' type events from 'poll' sources. Tasks and errors persist.
      const events = await readEvents()
      const acks = await readAcks()
      let ackCount = 0
      const newAcks = { ...acks }
      for (const event of events) {
        if (Object.hasOwn(newAcks, event.event_id)) continue // already acked
        if (event.source.includes('poll') && event.type === 'notice') {
          newAcks[event.event_id] = {
            acknowledged_at: new Date().toISOString(),
            action_taken: 'acknowledge',
          }
          ackCount++
        }
      }
      if (ackCount > 0) {
        await writeAcks(newAcks)
        console.log(`Auto-acked ${ackCount} poll notices`)
      }
      break
    }
    default:
      console.log(`Unknown command: ${cmd}`)
      console.log('Commands: status [--budget], ack <id>, ack-all, defer <id> <duration>, tasks, done <id>, budget, auto-ack-poll')
      process.exit(1)
  }
} catch (err: unknown) {
  if (err instanceof Error && err.name === 'EngineStateInvalidError') {
    // Surface the message, not a stack — the convention at plan.ts:198.
    console.error(err.message)
    process.exit(1)
  }
  throw err
}
