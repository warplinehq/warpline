/**
 * A capability member cannot be called without saying who is calling.
 *
 * The property is compile-time and it has exactly one observable form: a
 * `@ts-expect-error` above a call that omits the caller argument. That
 * directive is what makes this file a check rather than a claim, and it works
 * in both directions — TypeScript reports an error on a `@ts-expect-error`
 * line that has NO error beneath it, so the day the omission starts compiling
 * this file goes red under `bun run typecheck` with `error TS2578`. A comment
 * asserting the same thing would go quiet instead, which is the difference
 * between a guard and a note.
 *
 * `tsconfig.json` includes `src/**\/*.ts`, so `tsc --noEmit` reads this file.
 * `tsconfig.build.json` excludes `src/**\/__tests__/**`, so nothing here ships.
 *
 * The reasoning behind the obligation is NOT restated here. It is the grant
 * witness's docstring in `capabilities.ts`, one level out: the mint cannot be
 * called without saying whether the Grant was read, and a member cannot be
 * called without saying who is calling. Two copies of one argument drift, and
 * the copy that drifts is the one nobody is looking at.
 *
 * What is bought, stated exactly: a member call names its caller because the
 * signature requires it. Nothing here bounds what a handler can reach by other
 * means — it runs in this process and holds the whole environment. The
 * signature bounds the sanctioned path and that is the whole of it.
 */
import { describe, expect, test } from 'bun:test'
import { CAPABILITY_REGISTRY, mintContext, type CapabilityCaller } from '../capabilities.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'

const CALLER: CapabilityCaller = { plugin: 'e1-fixture', runId: 'run-e1' }

const MANIFEST = PluginManifestSchema.parse({
  name: 'e1-fixture',
  version: '1.0.0',
  description: 'a fixture manifest, used only to mint against',
  autonomy_level: 'autonomous',
  ttl_hours: 24,
  side_effects: [],
})

function handle() {
  return mintContext(
    { manifest: MANIFEST, caller: CALLER, resolvedSecretNames: ['E1_TOKEN'] },
    { granted: false, reason: 'manual-run' },
  ).context.secrets
}

/**
 * Never invoked. It exists to be READ by `tsc`, and calling it would run the
 * one call in this repository that is deliberately wrong. The directive below
 * is the assertion; the function body is only somewhere legal to put it.
 */
function _theCallThatMustNotCompile(): void {
  // @ts-expect-error — the caller argument is required. If this line ever
  // stops erroring, tsc reports TS2578 here and the build fails, which is the
  // regression this file exists to catch.
  handle().resolvedNames()
}

describe('a member cannot be called without saying who is calling', () => {
  /**
   * The other side of the boundary. Refusing the no-argument call proves
   * nothing on its own if the one-argument call does not work — a member
   * nobody can call is not a member.
   */
  test('the call with the caller argument compiles and returns the names', () => {
    expect(handle().resolvedNames(CALLER)).toEqual(['E1_TOKEN'])
  })

  /**
   * Those two are the whole boundary. A member's listing function takes one
   * parameter, so zero and one are the only arities either side of it and
   * there is no third case to check. No threshold, no rounding, no overflow
   * point exists in this surface — the criterion is arity. A member that one
   * day carries a numeric bound reopens that question rather than inheriting
   * this answer.
   */
  test('one parameter, so zero and one are the only arities', () => {
    expect(handle().resolvedNames.length).toBe(1)
  })

  /**
   * `caller` rides on the context beside the members so a handler can supply
   * the argument above without reconstructing an identity it was never given.
   * It is data, not a member: asserting it is absent from the registry is what
   * stops it reading as a member that slipped past the effect declaration.
   */
  test('the caller on the context is not a registered member', () => {
    expect('caller' in CAPABILITY_REGISTRY).toBe(false)
    expect(Object.keys(CAPABILITY_REGISTRY)).toEqual(['secrets'])
  })
})
