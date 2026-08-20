/**
 * `renderPlan` — pure-string assertions, no fixture home, no process spawn (D-27).
 *
 * The renderer takes a model and an injected `now` and returns a string, so
 * every one of the six output states is a plain equality/containment check.
 * Nothing here touches the filesystem; the builder's tests live in plan.test.ts.
 */
import { describe, test, expect } from 'bun:test'
import { renderPlan } from '../plan-render.js'
import type { PlanModel, PlanEntry, NotDueEntry } from '../plan-render.js'

/** Fixed clock for every case — the renderer must never read the real one. */
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0)

/** House pattern (staleness.test.ts): a local factory with overrides. */
function makeModel(overrides: Partial<PlanModel> = {}): PlanModel {
  return {
    pluginsDir: '/tmp/fixture-home/plugins',
    grant: { scopes: '*', expiresAt: NOW + 37 * 60_000 },
    due: [],
    notDue: [],
    failures: [],
    ...overrides,
  }
}

function due(overrides: Partial<PlanEntry> = {}): PlanEntry {
  return { plugin: 'feed-monitor', level: 0, sideEffects: [], approved: true, ...overrides }
}

function notDue(overrides: Partial<NotDueEntry> = {}): NotDueEntry {
  return {
    plugin: 'github-poll',
    level: 0,
    reason: 'fresh',
    detail: 'within TTL (24h) — last run 12m ago',
    ...overrides,
  }
}

describe('renderPlan', () => {
  test('Test 1: some due — side effects indented beneath their plugin, in declaration order, each marked', () => {
    const out = renderPlan(
      makeModel({
        due: [
          due({
            plugin: 'feed-monitor',
            level: 0,
            sideEffects: ['external_api', 'writes_db'],
            approved: true,
          }),
          due({
            plugin: 'digest-mailer',
            level: 1,
            sideEffects: ['sends_email'],
            approved: false,
          }),
        ],
        notDue: [notDue()],
      }),
      NOW,
    )

    expect(out).toContain('Due (2):')
    expect(out).toContain('Not due (1):')

    // Declaration order preserved, NOT alphabetical: external_api before writes_db.
    expect(out.indexOf('external_api')).toBeLessThan(out.indexOf('writes_db'))

    // Each side effect carries its own marker, indented one level deeper than
    // the plugin line it belongs to.
    expect(out).toContain('  feed-monitor (level 0)')
    expect(out).toContain('    external_api: ✓ approved')
    expect(out).toContain('    writes_db: ✓ approved')
    expect(out).toContain('  digest-mailer (level 1)')
    expect(out).toContain('    sends_email: ⚠ unapproved — would be SKIPPED this run')

    // The not-due section carries the exclusion reason.
    expect(out).toContain('  github-poll — within TTL (24h) — last run 12m ago')
  })

  test('Test 2: byte identity — two renders of one model are strictly equal and carry no ESC', () => {
    const model = makeModel({
      due: [due({ sideEffects: ['external_api'], approved: false })],
      notDue: [notDue()],
    })

    const first = renderPlan(model, NOW)
    const second = renderPlan(model, NOW)

    expect(first).toBe(second)
    // No ANSI, ever (D-21) - a colourised render would differ from a piped one.
    expect(first.includes(String.fromCharCode(0x1b))).toBe(false)
  })

  test('Test 3: none due — the distinct message plus the full not-due list', () => {
    const out = renderPlan(
      makeModel({
        notDue: [
          notDue({ plugin: 'github-poll' }),
          notDue({ plugin: 'anomaly-watch', reason: 'manual', detail: 'manual — requires explicit invocation' }),
        ],
      }),
      NOW,
    )

    expect(out).toContain('Nothing is due — no plugin passed the filter chain.')
    expect(out).toContain('Not due (2):')
    expect(out).toContain('  github-poll — within TTL (24h) — last run 12m ago')
    expect(out).toContain('  anomaly-watch — manual — requires explicit invocation')
    expect(out).not.toContain('No plugins installed.')
    expect(out).not.toContain('Due (')
  })

  test('Test 4: no plugins at all — names the resolved directory and points at scaffold', () => {
    const out = renderPlan(makeModel({ pluginsDir: '/tmp/empty-home/plugins' }), NOW)

    expect(out).toContain('No plugins installed.')
    expect(out).toContain('/tmp/empty-home/plugins')
    expect(out).toContain('warpline scaffold')
    expect(out).not.toContain('Nothing is due')
    expect(out).not.toContain('Not due (')
  })

  test('Test 5: ordering — dependency level, then alphabetical within a level', () => {
    const out = renderPlan(
      makeModel({
        due: [
          due({ plugin: 'zebra', level: 1 }),
          due({ plugin: 'alpha', level: 1 }),
          due({ plugin: 'omega', level: 0 }),
          due({ plugin: 'beta', level: 0 }),
        ],
        notDue: [notDue({ plugin: 'yankee', level: 1 }), notDue({ plugin: 'xray', level: 1 })],
      }),
      NOW,
    )

    const order = ['beta', 'omega', 'alpha', 'zebra'].map((n) => out.indexOf(`  ${n} (level`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every((i) => i >= 0)).toBe(true)

    expect(out.indexOf('  xray —')).toBeLessThan(out.indexOf('  yankee —'))
  })

  test('Test 6: zero load failures — no failures heading appears at all', () => {
    const out = renderPlan(
      makeModel({ due: [due()], notDue: [notDue()], failures: [] }),
      NOW,
    )

    expect(out).not.toContain('Load failures')
    expect(out).not.toContain('could not be loaded')
  })

  test('Test 7: partial load failure — both sections, plus an explicit incomplete warning', () => {
    const out = renderPlan(
      makeModel({
        due: [due()],
        notDue: [notDue()],
        failures: [{ plugin: 'broken-one', error: 'Unexpected token )' }],
      }),
      NOW,
    )

    expect(out).toContain('Load failures (1):')
    expect(out).toContain('  broken-one: Unexpected token )')
    expect(out).toContain('⚠ The due-set below is incomplete — 1 plugin directory could not be loaded.')
    expect(out).toContain('Due (1):')
    expect(out).toContain('Not due (1):')
    expect(out).not.toContain('No plan could be computed')
  })

  test('Test 8: total load failure — failures only, no-plan line, neither empty-state message', () => {
    const out = renderPlan(
      makeModel({
        failures: [
          { plugin: 'broken-one', error: 'Unexpected token )' },
          { plugin: 'broken-two', error: 'Cannot find module' },
        ],
      }),
      NOW,
    )

    expect(out).toContain('Load failures (2):')
    expect(out).toContain('  broken-one: Unexpected token )')
    expect(out).toContain('  broken-two: Cannot find module')
    expect(out).toContain('No plan could be computed — every plugin directory failed to load.')
    expect(out).not.toContain('No plugins installed.')
    expect(out).not.toContain('Nothing is due')
    expect(out).not.toContain('Due (')
    expect(out).not.toContain('Not due (')
  })

  test('Test 9: dependency cycle — every cycling plugin is named, no plan is claimed', () => {
    const out = renderPlan(
      makeModel({ cycle: ['alpha', 'beta'], notDue: [notDue()] }),
      NOW,
    )

    expect(out).toContain('Dependency cycle — no plan could be computed:')
    expect(out).toContain('  alpha')
    expect(out).toContain('  beta')
    expect(out).not.toContain('Due (')
    expect(out).not.toContain('Not due (')
    expect(out).not.toContain('Nothing is due')
  })

  test('Test 10: grant header — scopes and whole-minutes-rounded-down remaining time', () => {
    // 37 minutes 59 seconds remaining must read 37m, never 38m.
    const scoped = renderPlan(
      makeModel({
        grant: { scopes: ['github-poll', 'feed-monitor'], expiresAt: NOW + 37 * 60_000 + 59_000 },
      }),
      NOW,
    )
    expect(scoped).toContain('Grant: feed-monitor, github-poll — 37m remaining')

    const wildcard = renderPlan(
      makeModel({ grant: { scopes: '*', expiresAt: NOW + 2 * 60_000 } }),
      NOW,
    )
    expect(wildcard).toContain('Grant: all plugins (*) — 2m remaining ⚠ expires soon')

    const expired = renderPlan(
      makeModel({ grant: { scopes: '*', expiresAt: NOW - 1 } }),
      NOW,
    )
    expect(expired).toContain('Grant: all plugins (*) — expired')

    const none = renderPlan(makeModel({ grant: undefined }), NOW)
    expect(none).toContain(
      'Grant: none — plugins with side effects would be SKIPPED this run',
    )
  })

  test('Test 11 (backstop): a wide-character, astral-plane name round-trips intact', () => {
    const name = '日本語-プラグイン-𝕏-🛰'
    const out = renderPlan(
      makeModel({
        due: [due({ plugin: name, level: 0, sideEffects: ['modifies_file'], approved: true })],
        notDue: [notDue()],
      }),
      NOW,
    )

    // The name is reproduced byte-for-byte, not normalized or truncated.
    expect(out).toContain(`  ${name} (level 0)`)
    const line = out.split('\n').find((l) => l.includes(name))
    expect(line).toBe(`  ${name} (level 0)`)

    // Its side effect still sits exactly one indent level deeper, so no column
    // shifted: structure is indentation, not width.
    expect(out).toContain('    modifies_file: ✓ approved')
  })
})
