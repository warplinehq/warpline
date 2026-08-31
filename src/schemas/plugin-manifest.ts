import { z } from 'zod'

/**
 * Side effect types that a plugin may produce.
 *
 * A non-empty `side_effects` array gates execution behind session approval for
 * EVERY autonomy level, `autonomous` included. That is deliberate: a plugin
 * marked `autonomous` that also sends mail or writes to a database is the
 * highest-risk combination in the system, not the lowest — autonomy describes
 * how it is scheduled, never what it is permitted to touch. Grant approval via
 * `warpline approve`.
 *
 * (An earlier version of this comment read "used to gate plugin execution in
 * supervised/manual autonomy modes". That is wrong, and wrong in a plausible
 * enough way to have sent one debugging pass toward "re-honour autonomy_level
 * in the gate" — which would have undone the rule above. Left recorded here so
 * the next reader does not rediscover it the same way.)
 */
export const SideEffectType = z.enum([
  'sends_email',
  'creates_issue',
  'writes_db',
  'external_api',
  'modifies_file',
])
export type SideEffectType = z.infer<typeof SideEffectType>

/**
 * Autonomy levels for plugin execution.
 *   autonomous  — runs without human approval
 *   supervised  — runs but requires approval before side effects are applied
 *   manual      — never auto-runs; requires explicit user invocation
 */
export const AutonomyLevel = z.enum(['autonomous', 'supervised', 'manual'])
export type AutonomyLevel = z.infer<typeof AutonomyLevel>

/**
 * Plugin manifest schema. Every plugin in .warpline/plugins/{name}/manifest.ts
 * must export a value validated against this schema.
 *
 * Use .parse() (not .safeParse()) at plugin import time — invalid manifests
 * are a hard stop. A misconfigured plugin must not silently run.
 */
export const PluginManifestSchema = z.object({
  /**
   * Plugin key — must be unique across all plugins.
   *
   * A name that already exists on `Object.prototype` is refused. The name is a
   * KEY in `plugin_runs` and `denials`, both plain objects, so `__proto__`
   * would invoke the prototype setter and drop the record on write: the run
   * record vanishes and the plugin re-fires its side effects on the next
   * advance, which is the exact defect those records exist to close. The rest
   * of the prototype (`toString`, `constructor`, `valueOf`, …) answers a
   * lookup with an inherited member rather than the absence that is the truth.
   *
   * Derived from the prototype rather than listed, so it cannot go stale
   * against a future addition. `prototype` itself is not on it and is not
   * refused: it is not a member of `Object.prototype`, so it reads as absent
   * like any other unused key.
   */
  name: z
    .string()
    .min(1)
    .refine((n) => !(n in Object.prototype), {
      message: 'name collides with an Object.prototype member and cannot be a record key',
    }),

  /** Semantic version string */
  version: z.string().min(1),

  /** Human-readable description of what this plugin does */
  description: z.string(),

  /** Declared input parameters with types and descriptions */
  inputs: z.record(
    z.string(),
    z.object({
      /**
       * The shape of the value this input carries.
       *
       * A closed set. A value outside it fails `.parse()` rather than mapping
       * leniently at invoke time, and manifests are parsed at import time, so
       * a misspelled type name stops the plugin instead of running
       * unvalidated forever — the same bargain `outputs.temporality` makes
       * below.
       *
       * Narrowing this from a free string is a breaking change for a manifest
       * outside this repo declaring a name that is not here. That is
       * permitted by the pre-1.0 contract promise in § Contract stability of
       * `docs/runtime-spec.md`, and it is the accepted cost of the field
       * meaning anything at all. `array` and `object` are not admitted
       * because nothing declares them; adding a member later is additive.
       */
      type: z.enum(['string', 'number', 'boolean']),
      required: z.boolean().default(true),
      /**
       * The value this input takes when nobody supplies one.
       *
       * Optional, so the whole edit stays additive. This is the LOWEST tier of
       * the resolution order in `plugin-config.ts`: a declared default, then
       * `<home>/config/<plugin>.json`, then per-invocation args.
       *
       * Declared data rather than a sentence in `description`, which no
       * resolver can read. A default that lives only in prose is one the
       * handler has to re-implement, and the two drift.
       */
      default: z.unknown().optional(),
      description: z.string().optional(),
    }),
  ).default({}),

  /** Declared outputs with types and descriptions */
  outputs: z.record(
    z.string(),
    z.object({
      type: z.string(),
      description: z.string().optional(),
      /**
       * What a re-run does to this output.
       *
       * `versioned` — each run yields a new Output instance; the latest is
       * shown by default and older ones stay reachable while their producing
       * run log survives.
       * `replace` — a run overwrites the previous Output. The default, so an
       * output that says nothing is not versioned.
       *
       * A value outside the enum fails `.parse()` rather than falling back to
       * the default, and manifests are parsed at import time, so a plugin
       * cannot quietly run under a versioning policy nobody declared.
       */
      temporality: z.enum(['versioned', 'replace']).default('replace'),
    }),
  ).default({}),

  /** Capability tags (e.g. 'network_read', 'file_write') — informational */
  capabilities: z.array(z.string()).default([]),

  /** When to run this plugin */
  schedule: z.enum(['on_run', 'daily', 'weekly', 'manual']).default('on_run'),

  /** Human oversight requirement for execution and side effects */
  autonomy_level: AutonomyLevel,

  /** Side effects this plugin may produce — must be declared for supervised/manual gating */
  side_effects: z.array(SideEffectType).default([]),

  /**
   * Result freshness window in hours.
   * If the last successful run was within ttl_hours, the engine may skip re-running.
   * Must be a positive number (0 or negative would disable caching entirely).
   */
  ttl_hours: z.number().positive(),

  /** Plugin keys that must complete successfully before this plugin runs */
  dependencies: z.array(z.string()).default([]),

  /** Maximum execution time in milliseconds before the engine cancels the run */
  timeout_ms: z.number().int().positive().default(60_000),

  /**
   * Maximum number of retries on `retryable: true` failures.
   * Bounded so a retry storm cannot run unattended.
   * Total attempts = 1 initial + max_retries retries.
   */
  max_retries: z.number().int().min(0).max(10).default(1),

  /**
   * Base delay in milliseconds between retry attempts.
   * Actual delay uses exponential backoff + ±25% jitter, capped at 30s.
   */
  retry_delay_ms: z.number().int().min(0).max(60_000).default(2000),

  /**
   * Optional action registry.
   * Keys are action names; values describe each action and optionally flag the default.
   * Only surfaces in a host UI when non-empty; the bundled examples do not declare it.
   */
  actions: z.record(z.string(), z.object({
    description: z.string(),
    is_default: z.boolean().optional(),
  })).optional(),

  /** Maximum concurrent instances of this plugin the engine will run */
  max_parallelism: z.number().int().min(1).default(1),

  /**
   * Minimum degradation tier in which this plugin is eligible to run.
   * 'normal'    = only runs when system is healthy (default -- most restrictive).
   * 'suspended' = always runs regardless of tier (health checks, manual plugins).
   */
  min_tier: z.enum(['normal', 'degraded', 'extended', 'suspended']).default('normal'),
})

export type PluginManifest = z.infer<typeof PluginManifestSchema>
