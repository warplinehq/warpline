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
 * The registry carries two members, both ungated: the credential-name handle
 * and the reader for a declared dependency — what it last produced, and how its
 * last run ended. The apparatus — the required effect field, the projection,
 * the refusal, the witness — was
 * built and proven before either of them, which is why each arrived already
 * covered by the registry-iterating refusal test and needed no assertion
 * written for it. That is the property the shape was chosen for, and a third
 * member should cost the same.
 */
import type { PluginRun } from '../schemas/engine-state.js'
import type { PluginManifest, SideEffectType } from '../schemas/plugin-manifest.js'
import type { OutputRecord } from '../schemas/skill-result.js'

/**
 * The two fields of a dependency's last run that may be handed to a different
 * plugin — and the whole list of them.
 *
 * A `Pick`, never the whole `PluginRun`. This type is the boundary where a
 * field is CHOSEN for exposure across the seam, which makes it the one place a
 * leak can enter. The free text a producer's failure becomes is built in two
 * places from whatever a handler threw — `invoke-plugin.ts:771-789` for a
 * handler throw, which puts it into both the result's `summary` and its
 * `errors[0].message`, and `engine.ts:1057-1071` for `invokePlugin` itself
 * throwing. Naming two fields here does not merely leave that text unreturned;
 * it keeps it out of the mint's scope entirely.
 *
 * ONE projection for both facts, and not two. The engine mutates
 * `state.plugin_runs` during its level loop, so two independent reads of it
 * could describe two different runs, and the one that drifted would be the one
 * nobody read.
 */
export type DependencyRun = Pick<PluginRun, 'status' | 'last_output'>

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
  /**
   * What each of this plugin's declared dependencies last produced, and how
   * that dependency's last run ended — already resolved by the caller, and
   * `null` for a name the caller has no run for. A plain record and never a
   * function: the mint runs once per invocation, above the retry loop, so a
   * closure here could hand two attempts of one invocation different answers.
   */
  readonly dependencyRuns?: Readonly<Record<string, DependencyRun | null>>
}

/** What a member's mint function receives, with the optional fields settled. */
export interface CapabilityMintArgs {
  readonly manifest: PluginManifest
  readonly caller: CapabilityCaller
  readonly resolvedSecretNames: readonly string[]
  readonly dependencyRuns: Readonly<Record<string, DependencyRun | null>>
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
 * Two members, and both are UNGATED — `effect: null` — which in each case is a
 * measured decision rather than a convenience. The unit `secrets` stands for is
 * a pre-flight read of the process environment; the unit `dependencies` stands
 * for is a projection of a value the runtime is already holding. Neither is any
 * of the five values `side_effects` is drawn from, so keying either on one of
 * them would be a declaration nobody could truthfully make.
 *
 * The consequence is the one that matters at the seams, and it is the same
 * consequence for both: a run started by hand through the CLI, which reads no
 * grant and passes an explicit not-granted witness, still receives them. No
 * existing behaviour changed on the day either landed, and a handler never
 * branches on whether it was handed a member at all.
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
  dependencies: {
    effect: null,
    description:
      'Reads the Output a plugin this manifest declared as a dependency last produced, and how its last run ended. Declared names only — an undeclared one throws.',
    mint: (args): DependenciesHandle => {
      // ONE refusal, shared by both members. Two copies would be two rules
      // about the same declaration, and the second could drift into the laxer
      // one without anything noticing. It interpolates the manifest name, the
      // requested name and the literal manifest field name, and never a value
      // read from the record or from state — the message discipline stated
      // once instead of per member.
      const requireDeclared = (dependencyName: string, asked: string): void => {
        if (!args.manifest.dependencies.includes(dependencyName)) {
          throw new Error(
            `Plugin '${args.manifest.name}' requested ${asked} of '${dependencyName}', which it does not ` +
              `declare: add '${dependencyName}' to manifest.dependencies, an array of plugin names, ` +
              `before reading it.`,
          )
        }
      }

      return {
        lastOutput: (caller, dependencyName): OutputRecord | null => {
          // The caller is required and unread, for the reason `SecretsHandle`
          // states. `void` keeps it from being deleted as dead code.
          void caller
          requireDeclared(dependencyName, 'the Output')
          return args.dependencyRuns[dependencyName]?.last_output ?? null
        },
        lastRun: (caller, dependencyName): PluginRun['status'] | null => {
          void caller
          requireDeclared(dependencyName, 'the run status')
          return args.dependencyRuns[dependencyName]?.status ?? null
        },
      }
    },
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
 * The handle reading what a declared dependency last produced.
 *
 * `plugin_runs[name].last_output` already exists. The engine writes it on both
 * arms, the Board reads it to name an Output without scanning the runs
 * directory, and until this member landed no plugin could see it at all. This
 * is that read and nothing else, so it is worth saying plainly what it is not.
 *
 * **It is not a store.** The records are handed to the mint by the caller
 * rather than loaded here. A member that loaded state would be a second place
 * the answer to "what did my dependency produce" comes from, and the two could
 * disagree — the run-log pruning rule applies by mtime to the runs directory
 * and not to the state document, so the disagreement would be a real one and
 * would arrive on a schedule nobody was watching.
 *
 * **It is not a freshness check.** `isPluginFresh` already answers "has
 * anything changed upstream" from `plugin_runs[dep].last_run_at`. The record
 * returned here carries no verdict about its own age and this module imports
 * nothing that could compute one. Two answers to that question is the failure
 * being refused; one of them being subtly better is not a defence.
 *
 * **It does not read the filesystem.** It closes over a value the caller
 * supplied, which is also what makes it testable from a literal. Note that an
 * Output may carry a `path` rather than a `body`; resolving that path is the
 * handler's business — `readJsonOrNull` from `warpline/unstable-fs` is the
 * sanctioned way — and doing it here is how this member would acquire the disk
 * access the sentence above rules out.
 *
 * **What `null` means from each member, and what the pair answers together.**
 * `lastOutput` returns `null` for exactly one thing: this plugin has never
 * produced an Output. That is a fact about the PLUGIN, not about its last run —
 * a run producing none carries the prior record forward (`lastOutputOf` in
 * `engine.ts`), so a producer that succeeded yesterday and failed this morning
 * still reads as having produced. `lastRun` returns `null` for one thing too:
 * this plugin has never run. Between them a consumer can name four states —
 * never run; ran and has never produced; produced, and its latest run failed;
 * produced, and its latest run is healthy — and a supervised producer parked at
 * a gate reads `gated`, which is an answer rather than an error.
 *
 * An earlier version of this docstring argued that collapsing "has never run"
 * into "produced nothing" was deliberate, because a handler could not act on
 * the difference. Both halves of that argument were wrong and the argument was
 * withdrawn on 2026-09-07: a handler CAN act on the difference between a
 * producer that has not started and one whose last attempt failed, and both
 * shipped examples were publishing the first claim in the second case.
 *
 * **The status is a closed enum, and the failure TEXT is deliberately not
 * here.** A producer's thrown message becomes free text in two places —
 * `invoke-plugin.ts:771-789` for a handler throw, into both the result's
 * `summary` and its `errors[0].message`, and `engine.ts:1057-1071` for
 * `invokePlugin` itself throwing — and that text carries whatever the handler
 * was holding, operator paths included. `DependencyRun` is the boundary that
 * keeps it out of scope, and `dependency-run-status-leak.test.ts` is the alarm.
 * A change that hands the mint a whole `PluginRun`, or anything read from the
 * run log, is the change both exist to stop.
 *
 * An **undeclared** name is a different matter and throws. Returning `null` for
 * it would make a typo in `manifest.dependencies` indistinguishable from a
 * dependency that has not run yet — the same value, two unrelated fixes, and
 * the wrong one is the one that looks like waiting. The refusal keys off the
 * DECLARATION and never off the keys of the record handed in: a name that
 * happened to be delivered is still a read the graph does not authorise. The
 * message names the requested dependency and the manifest field that must list
 * it, and never a value read from the record.
 *
 * Two methods, and still no enumeration. A handler cannot walk what it was
 * handed, so the order of `manifest.dependencies` and the order of the caller's
 * projection are unobservable here and are not contract.
 *
 * The second method is not a widening, and the distinction is the whole reason
 * a rule against one was withdrawn rather than broken: it is the SAME declared
 * read answering a second fact about the same name, and the two constraints
 * that matter are untouched. It cannot be asked about a name this manifest does
 * not declare, and it hands over no way to walk what was delivered. A third
 * member that could do either would be a widening no matter how it was spelled.
 */
export interface DependenciesHandle {
  readonly lastOutput: (
    caller: CapabilityCaller,
    dependencyName: string,
  ) => OutputRecord | null
  readonly lastRun: (
    caller: CapabilityCaller,
    dependencyName: string,
  ) => PluginRun['status'] | null
}

/**
 * The object a handler is handed: the members this plugin is entitled to, the
 * caller they were minted for, and nothing else.
 *
 * The index signature stays — a member's value is `unknown` until a handler
 * narrows it, and the fixture-registry test seam mints members this type has
 * never heard of. The three named keys are what a plugin author can reach
 * without a cast, and they are named because all three are always present in
 * production: `secrets` and `dependencies` are ungated, so they are minted for
 * every plugin on every run, and `caller` is written unconditionally.
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
  readonly dependencies: DependenciesHandle
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
    dependencyRuns: input.dependencyRuns ?? {},
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
  // cannot see. Production always mints every ungated member — `secrets` and
  // `dependencies` today, and no manifest and no witness can withhold either,
  // because a `null` effect skips both arms above — and `caller` is written
  // unconditionally, so a production context always satisfies the named keys.
  // Only the `registry` test seam can produce a context missing them, and a
  // test that mints against fixture members is already reading its own
  // registry rather than this type's promises.
  return { context: context as CapabilityContext, withheld }
}
