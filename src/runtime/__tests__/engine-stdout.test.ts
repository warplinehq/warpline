/**
 * The engine writes nothing to stdout — asserted against the module's own
 * source text, deliberately.
 *
 * **Why this is source-level and not behavioural.** Stated here at length,
 * because a future reader will otherwise rewrite it as a behavioural test,
 * watch the suite stay green, and lose the property entirely.
 *
 *   1. `console.log` does not go through `process.stdout.write` in the test
 *      runner's own scope. Every `capture()` helper in this repository patches
 *      that write function, and a throwaway case run inside `bun test` — patch
 *      the write, `console.log('X')`, then `process.stdout.write('Y')` —
 *      captured only `Y` while `X` printed to the real terminal above the
 *      runner's summary. So an in-process purity test reads clean over a dirty
 *      pipe: a guard running green while the thing it catches sits outside its
 *      reach.
 *   2. The process-launching tests this repository budgets are interrupt
 *      proofs, and each kills its child before any payload is emitted. Neither
 *      can observe this property either.
 *
 * There is therefore no behavioural instrument for this at all, and this check
 * is **not** a substitute for one — it is the only thing that reaches the
 * property. Deleting it on the grounds that a behavioural `--json` test covers
 * the same ground would be a mistake: that test's in-process stdout capture is
 * only truthful because the engine's diagnostics are on stderr, which is the
 * thing this file keeps true.
 *
 * **What it protects.** `warpline advance --json` emits one JSON document on
 * stdout and nothing else. A diagnostic line above that document is a parse
 * failure in a monitor nobody can patch from here, and quiet hours is a normal
 * arm — so the corruption would arrive on an ordinary scheduled night rather
 * than on an exotic one.
 *
 * **Scope is the engine module only, on purpose.** The CLI verbs write to
 * stdout because that is their job; a tree-wide ban would be unsatisfiable and
 * would be relaxed by the first person it inconvenienced. `console.error` and
 * `console.warn` already go to stderr and are not in scope.
 *
 * The writer this scope leaves out is the plugin handler, and reading that
 * omission as coverage is what let one `console.log` in somebody's plugin
 * corrupt the document for a whole phase. It is not covered from here and it
 * cannot be: a handler is third-party source this guard has no text for.
 * `invokePlugin` redirects handler stdout to stderr at run time instead, and
 * `advance.test.ts` proves that behaviourally with a plugin that prints through
 * both writers. Two halves of one property, neither reachable by the other's
 * method.
 *
 * The precedent is `src/cli/__tests__/dispatcher.test.ts`, which reads the
 * dispatcher's own source for exactly this reason: a property no behavioural
 * arm reaches.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The one module this guard is scoped to, resolved from a named constant. */
const ENGINE_SOURCE_PATH = fileURLToPath(new URL('../engine.ts', import.meta.url))
const ENGINE_SOURCE = readFileSync(ENGINE_SOURCE_PATH, 'utf-8')

/** The two console helpers that write to stdout. The other two write to stderr. */
const STDOUT_CONSOLE = /console\.(?:log|info)\(/g

describe('the engine writes nothing to stdout', () => {
  test('no direct stdout-writing console call survives in the engine module', () => {
    // Anchors the read before the assertion depends on it. An empty file, a
    // renamed module or a path that stopped resolving would satisfy an
    // empty-match assertion while proving nothing — "clean" and "did not look"
    // must not be indistinguishable from outside.
    expect(ENGINE_SOURCE).toContain('export async function runAdvance')

    // Reported with line numbers rather than as a count: when this goes red the
    // failure has to name the sites, because the whole remedy is moving them.
    const offenders = [...ENGINE_SOURCE.matchAll(STDOUT_CONSOLE)].map(
      (m) => `engine.ts:${ENGINE_SOURCE.slice(0, m.index).split('\n').length}: ${m[0]}`,
    )

    expect(offenders).toEqual([])
  })
})
