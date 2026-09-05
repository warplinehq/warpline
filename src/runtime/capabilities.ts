/**
 * The capability registry, its effects projection, and the mint.
 *
 * One idea, in three parts:
 *
 *   1. `CAPABILITY_REGISTRY` — every member the runtime can hand a handler,
 *      each carrying a REQUIRED declared effect. Required is the point: an
 *      entry without one is a TypeScript error before any test runs.
 *   2. `CAPABILITY_EFFECTS` — the member-to-effect table, derived from the
 *      registry rather than written a second time. Two hand-maintained tables
 *      are two things that can disagree, and disagreement is exactly what the
 *      table-driven refusal test exists to catch.
 *   3. `mintContext` — builds the per-invocation object of members a plugin is
 *      entitled to, from what its manifest declared and from a grant witness
 *      its caller must supply.
 *
 * **This module never reads the grant file, and imports nothing that does.**
 * The engine performs the single Grant read before invocation and passes the
 * answer forward as a witness. Two reads means two places to get the gate
 * wrong, and the second one would sit inside code a plugin author is holding.
 * `src/__tests__/no-grant-recheck.test.ts` is what keeps that true.
 *
 * The registry carries one member: the credential-name handle. The apparatus
 * — the required effect field, the projection, the refusal, the witness — was
 * built and proven before it, which is why it arrived already covered by the
 * registry-iterating refusal test and needed no assertion written for it.
 */
import type { PluginManifest, SideEffectType } from '../schemas/plugin-manifest.js'

/**
 * What the caller learned when it read the Grant, carried forward.
 *
 * **It cannot be omitted** — it is a separate, non-defaulted parameter of
 * `mintContext`, so a new caller does not compile without answering. That is
 * the property being bought: the obligation is fixed at the level of the
 * signature, not as a rule each call site has to remember. It is deliberately
 * NOT described as unforgeable. Within one package a caller can always
 * construct the literal, and claiming otherwise in a docstring would be an
 * overclaim about containment this runtime does not have.
 *
 * The granted arm carries the **scope the Grant was read for**, not a bare
 * boolean. A wildcard grant answers true for every scope requested of it, so a
 * boolean cannot distinguish "granted for this plugin" from "granted for
 * everything" — and the coexistence window keeps two separate grants for
 * precisely that reason. Recording the scope keeps that partition legible to
 * anything downstream instead of quietly re-merging it. It is the scope the
 * caller ASKED about, which is the only thing the caller can honestly report.
 *
 * The not-granted arm is closed at the two production cases: a run started by
 * hand, which reads no Grant at all, and a plugin declaring no side effects,
 * which needs none.
 */
export type CapabilityGrantWitness =
  | { readonly granted: true; readonly scope: string }
  | { readonly granted: false; readonly reason: 'manual-run' | 'no-declared-side-effects' }

/**
 * Who a member is being minted for, and who a member call must name.
 *
 * This is the type the caller-identity entry criterion is about. Every member
 * takes one of these as its FIRST parameter, non-defaulted and non-optional,
 * so a call that does not say who is calling is a compile error rather than a
 * convention. `capability-e1.test.ts` is where that is watched.
 *
 * `runId` stays optional, and the reason is worth stating rather than reading
 * as an oversight. `invokePlugin` always supplies one — it mints an id when
 * its caller passed none — so every production mint carries a run id. What
 * cannot honestly carry one is `mintContext`'s own fallback when a test seam
 * omits the caller entirely: an invented run id there would be a fabricated
 * value in a field a member could one day write into a run artifact, which is
 * worse than an absent one.
 */
export interface CapabilityCaller {
  readonly plugin: string
  readonly runId?: string
}

/**
 * What `mintContext` is handed.
 *
 * An object from the start, not a bare manifest, and every field beyond
 * `manifest` optional. A member needing resolved secret names or a run id can
 * then be registered without changing a single existing call — including the
 * calls in the refusal test, whose whole demonstration is that adding a member
 * requires no edit to it.
 */
export interface CapabilityMintInput {
  readonly manifest: PluginManifest
  readonly caller?: CapabilityCaller
  readonly resolvedSecretNames?: readonly string[]
}

/** What a member's mint function receives, with the optional fields settled. */
export interface CapabilityMintArgs {
  readonly manifest: PluginManifest
  readonly caller: CapabilityCaller
  readonly resolvedSecretNames: readonly string[]
}

/**
 * One registry entry.
 *
 * `effect` is required and may be `null`. `null` means ungated: the member
 * performs no declared side effect and is minted for every plugin. There is no
 * third state — "nobody said" is the state this type exists to make
 * unrepresentable.
 */
export interface CapabilityEntry {
  readonly effect: SideEffectType | null
  /** One line, rendered into the generated table an operator reads. */
  readonly description: string
  readonly mint: (args: CapabilityMintArgs) => unknown
}

/**
 * Every capability member, keyed by the name it appears under in a handler's
 * context.
 *
 * One member: the credential-name handle. It is UNGATED — `effect: null` —
 * and that is a measured decision rather than a convenience. The unit it
 * stands for is a pre-flight read of the process environment, which is none of
 * the five values `side_effects` is drawn from, so keying it on one of them
 * would be a declaration nobody could truthfully make. The consequence is the
 * one that matters at the seams: a run started by hand through the CLI, which
 * reads no grant and passes an explicit not-granted witness, still receives it
 * — so no existing behaviour changed on the day it landed.
 */
export const CAPABILITY_REGISTRY: Readonly<Record<string, CapabilityEntry>> = {
  secrets: {
    effect: null,
    description:
      'Lists the credential names this plugin declared and the runtime resolved. Names only — never a value.',
    mint: (args): SecretsHandle => ({
      resolvedNames: (caller: CapabilityCaller): readonly string[] => {
        // The caller is required and unread. See `SecretsHandle` for why that
        // is deliberate; `void` is here so nobody deletes the parameter as
        // dead, which would take the entry criterion with it.
        void caller
        return args.resolvedSecretNames
      },
    }),
  },
}

/**
 * Member name to declared effect — a PROJECTION of the registry above, in the
 * shape of this codebase's other derived lookup (`RUN_PROFILES` off
 * `PROFILE_ALLOWED_SCHEDULES`). Derived rather than restated so a member cannot
 * be added to one and forgotten in the other.
 */
export const CAPABILITY_EFFECTS: Readonly<Record<string, SideEffectType | null>> =
  Object.fromEntries(
    Object.entries(CAPABILITY_REGISTRY).map(([name, entry]) => [name, entry.effect]),
  )

/** A member that was not minted, and the reason a plugin author can act on. */
export interface WithheldMember {
  readonly member: string
  readonly effect: SideEffectType
  readonly reason: string
}

/**
 * The handle listing the credential names this invocation resolved.
 *
 * **Names, and no member that returns a value — in any form.** Not a lookup,
 * not an accessor, not a test-only escape. A handler runs in this process and
 * holds `process.env` regardless, so a getter here would buy a violated
 * requirement and no containment whatsoever. What the declaration bounds is
 * the SANCTIONED path, and this is that path's whole surface.
 *
 * Every name it lists RESOLVED. The pre-flight in `secrets.ts` refuses the run
 * before the handler is called when a declared name is absent or empty, so
 * this handle has no partial state to represent — a defensive branch for a
 * declared-but-missing name here is a branch that can never be taken.
 *
 * `caller` is required and is deliberately not read today. The obligation
 * belongs at the signature from the first member onwards: a member that DOES
 * vary its answer by caller then inherits it, where adding a required
 * parameter to an already-published member type would be a breaking change.
 */
export interface SecretsHandle {
  readonly resolvedNames: (caller: CapabilityCaller) => readonly string[]
}

/**
 * The object a handler is handed: the members this plugin is entitled to, the
 * caller they were minted for, and nothing else.
 *
 * The index signature stays — a member's value is `unknown` until a handler
 * narrows it, and the fixture-registry test seam mints members this type has
 * never heard of. The two named keys are what a plugin author can reach
 * without a cast, and they are named because both are always present in
 * production: `secrets` is ungated, so it is minted for every plugin on every
 * run, and `caller` is written unconditionally.
 *
 * **`caller` is not a capability member.** It performs nothing, it is keyed off
 * no effect, and it appears in no row of the generated table. It is the
 * invocation's identity, carried on the context because a handler is called
 * with `(manifest, args, signal, capabilities)` and has no run id of its own —
 * without it, the caller argument every member requires would be one no plugin
 * author could honestly supply. `capability-e1.test.ts` asserts it is absent
 * from the registry, so it cannot be mistaken for a member that skipped the
 * effect declaration.
 */
export type CapabilityContext = Readonly<Record<string, unknown>> & {
  readonly caller: CapabilityCaller
  readonly secrets: SecretsHandle
}

/** What `mintContext` returns: the handler's members, and what was held back. */
export interface MintedContext {
  /** The object handed to a handler. Only members it is entitled to. */
  readonly context: CapabilityContext
  /** One entry per member withheld, in registry order. */
  readonly withheld: readonly WithheldMember[]
}

/**
 * The refusal for an effect the manifest did not declare.
 *
 * It names the missing entry and the manifest line to add, and nothing else.
 * The same discipline the invalid-config failure keeps: name the key and the
 * shape expected of it, never a value that was read. Every string it
 * interpolates comes from this module's own registry or from the closed effect
 * enum, so there is no path by which an operator's configured value reaches it.
 */
function undeclaredEffect(member: string, effect: SideEffectType): string {
  return (
    `${member} was not minted: its declared effect '${effect}' is absent from ` +
    `the manifest's side_effects. Add side_effects: ['${effect}'] to manifest.ts to receive it.`
  )
}

/** The refusal for a declared effect on a run carrying no grant. */
function noGrant(member: string, effect: SideEffectType): string {
  return (
    `${member} was not minted: it performs '${effect}', and this run carries no ` +
    'approval for that. Grant it with `warpline approve`, or run a plugin that declares no side_effects.'
  )
}

/**
 * Build the capability context for one invocation.
 *
 * A member whose declared effect is a real effect is minted only when BOTH
 * hold: the manifest's `side_effects` contains that exact effect, and the
 * witness says granted. A member whose effect is `null` is minted always.
 *
 * The effect comparison is exact string equality against the array the manifest
 * parsed into. Never lowercased, never trimmed: both values come from the same
 * closed five-value enum, so anything a normalisation step would rescue is a
 * registry that has drifted from that enum, and rescuing it silently is how the
 * drift survives.
 *
 * `registry` is a **test seam**, in the spirit of the home-directory override
 * in `src/lib/paths.ts`: it exists so a test can mint against fixture members
 * that production does not have. Production callers pass two arguments.
 */
export function mintContext(
  input: CapabilityMintInput,
  witness: CapabilityGrantWitness,
  registry: Readonly<Record<string, CapabilityEntry>> = CAPABILITY_REGISTRY,
): MintedContext {
  const declared = input.manifest.side_effects
  const args: CapabilityMintArgs = {
    manifest: input.manifest,
    caller: input.caller ?? { plugin: input.manifest.name },
    resolvedSecretNames: input.resolvedSecretNames ?? [],
  }

  // `caller` first, so it is present whatever the registry does. It is data,
  // not a member: no effect keys it and no table row names it.
  const context: Record<string, unknown> = { caller: args.caller }
  const withheld: WithheldMember[] = []

  for (const [member, entry] of Object.entries(registry)) {
    const effect = entry.effect
    if (effect !== null) {
      if (!declared.includes(effect)) {
        withheld.push({ member, effect, reason: undeclaredEffect(member, effect) })
        continue
      }
      if (!witness.granted) {
        withheld.push({ member, effect, reason: noGrant(member, effect) })
        continue
      }
    }
    context[member] = entry.mint(args)
  }

  // The cast is the one place this module asserts something the compiler
  // cannot see. Production always mints `secrets` — it is ungated, so no
  // manifest and no witness can withhold it — and `caller` is written above
  // unconditionally, so a production context always satisfies the named keys.
  // Only the `registry` test seam can produce a context missing them, and a
  // test that mints against fixture members is already reading its own
  // registry rather than this type's promises.
  return { context: context as CapabilityContext, withheld }
}
