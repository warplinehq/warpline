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
 * (This comment previously read "used to gate plugin execution in
 * supervised/manual autonomy modes", which predates D-02 and contradicts it. It
 * is a convincing enough misdirection that it sent a debugging pass toward
 * "re-honour autonomy_level in the gate" — which would have reverted the whole
 * point of Phase 88. Per D-07, D-08.)
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
 * Per D-08:
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
 * are a hard-stop per D-09. A misconfigured plugin must not silently run.
 */
export const PluginManifestSchema = z.object({
  /** Plugin key — must be unique across all plugins */
  name: z.string().min(1),

  /** Semantic version string */
  version: z.string().min(1),

  /** Human-readable description of what this plugin does */
  description: z.string(),

  /** Declared input parameters with types and descriptions */
  inputs: z.record(
    z.string(),
    z.object({
      type: z.string(),
      required: z.boolean().default(true),
      description: z.string().optional(),
    }),
  ).default({}),

  /** Declared outputs with types and descriptions */
  outputs: z.record(
    z.string(),
    z.object({
      type: z.string(),
      description: z.string().optional(),
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
   * Bounded per Phase 121 D-07. Default 1 preserves the pre-121 "one retry" behavior.
   * Total attempts = 1 initial + max_retries retries.
   */
  max_retries: z.number().int().min(0).max(10).default(1),

  /**
   * Base delay in milliseconds between retry attempts.
   * Actual delay uses exponential backoff + ±25% jitter, capped at 30s (Phase 121 D-04/D-05/D-06).
   * Default 2000 matches the pre-121 hardcoded backoff.
   */
  retry_delay_ms: z.number().int().min(0).max(60_000).default(2000),

  /**
   * Optional action registry (Phase 121 D-30).
   * Keys are action names; values describe each action and optionally flag the default.
   * Only surfaces in dashboard UI when non-empty — zero existing plugins declare it today.
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
   * Phase 109, D-22.
   */
  min_tier: z.enum(['normal', 'degraded', 'extended', 'suspended']).default('normal'),
})

export type PluginManifest = z.infer<typeof PluginManifestSchema>
