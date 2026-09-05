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
 * At this commit the registry is empty of production members. That is
 * deliberate: the apparatus — the required effect field, the projection, the
 * refusal, the witness — is proven before any authority flows through it, and
 * the first member arrives already covered by it.
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
 * Who a member is being minted for.
 *
 * `runId` is optional today because nothing in the runtime calls `mintContext`
 * yet, and an invented run id would be worse than an absent one. It becomes
 * required with the caller-identity entry criterion, which lands alongside the
 * first member that has anything to write under a run.
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
 * context. Empty of production members at this commit.
 */
export const CAPABILITY_REGISTRY: Readonly<Record<string, CapabilityEntry>> = {}

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
 * The object a handler is handed: the members this plugin is entitled to, and
 * nothing else. Values are `unknown` because the registry is empty of
 * production members; the first member is what gives this type a shape worth
 * narrowing, and narrowing it before then would be a shape nobody has.
 */
export type CapabilityContext = Readonly<Record<string, unknown>>

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

  const context: Record<string, unknown> = {}
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

  return { context, withheld }
}
