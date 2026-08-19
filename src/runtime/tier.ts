/**
 * Graceful degradation tier system for Warpline.
 *
 * Design decisions:
 *   D-02: Tier computed from last_interaction_at (idle duration)
 *   D-22: min_tier semantics — 'suspended' = always runs, 'normal' = most restrictive
 *   D-07: Soft-archive in suspended tier (archived_at on TaskAging)
 *
 * Tiers (from healthiest to most degraded):
 *   normal    — 0–2 days idle, all plugins run
 *   degraded  — 2–7 days idle, reduced plugin set
 *   extended  — 7–14 days idle, minimal plugins
 *   suspended — 14+ days idle, only health checks
 *
 * T-109-02 mitigation: invalid date strings produce NaN idle time;
 * guard returns 'normal' (same as null — no penalty for bad data).
 */

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

/** Degradation tier — ordered from healthiest to most degraded. */
export type TierName = 'normal' | 'degraded' | 'extended' | 'suspended'

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** Idle duration thresholds in milliseconds for each tier transition. */
export const TIER_THRESHOLDS_MS = {
  degraded: 2 * 24 * 60 * 60 * 1000,   // 2 days
  extended: 7 * 24 * 60 * 60 * 1000,   // 7 days
  suspended: 14 * 24 * 60 * 60 * 1000, // 14 days
} as const

/** Numeric ordering of tiers — lower = healthier. */
export const TIER_ORDER: Record<TierName, number> = {
  normal: 0,
  degraded: 1,
  extended: 2,
  suspended: 3,
} as const

// -------------------------------------------------------------------------
// computeTier
// -------------------------------------------------------------------------

/**
 * Compute the current degradation tier from the last interaction timestamp.
 *
 * Pitfall 1: null/undefined last_interaction_at returns 'normal' — fresh
 * installs should not be penalised.
 *
 * T-109-02: Invalid date strings (NaN idle time) also return 'normal'.
 *
 * @param lastInteractionAt - ISO 8601 timestamp of last warpline invocation
 * @param now - Current time in ms (default: Date.now()). Exposed for testing.
 */
export function computeTier(
  lastInteractionAt: string | null | undefined,
  now: number = Date.now(),
): TierName {
  if (!lastInteractionAt) return 'normal'

  const idleMs = now - new Date(lastInteractionAt).getTime()

  // T-109-02: guard against NaN from invalid date strings
  if (Number.isNaN(idleMs)) return 'normal'

  if (idleMs >= TIER_THRESHOLDS_MS.suspended) return 'suspended'
  if (idleMs >= TIER_THRESHOLDS_MS.extended) return 'extended'
  if (idleMs >= TIER_THRESHOLDS_MS.degraded) return 'degraded'
  return 'normal'
}

// -------------------------------------------------------------------------
// isEligibleForTier
// -------------------------------------------------------------------------

/**
 * Determine whether a plugin is eligible to run in the current tier.
 *
 * CRITICAL SEMANTIC (D-22, Pitfall 2):
 *   min_tier: 'suspended' = "always runs" (health checks) — least restrictive
 *   min_tier: 'normal'    = "only runs in normal tier"     — most restrictive
 *
 * A plugin runs when the current tier's order is <= the plugin's min_tier order.
 * i.e. the system must be at least as healthy as the plugin requires, OR the
 * plugin tolerates the current degradation level.
 *
 * @param pluginMinTier - The plugin's declared minimum tier (from manifest)
 * @param currentTier   - The system's current computed tier
 */
export function isEligibleForTier(
  pluginMinTier: TierName,
  currentTier: TierName,
): boolean {
  return TIER_ORDER[currentTier] <= TIER_ORDER[pluginMinTier]
}

// -------------------------------------------------------------------------
// formatIdleDuration
// -------------------------------------------------------------------------

/**
 * Format an idle duration in milliseconds to a human-readable string.
 *
 * @param idleMs - Idle duration in milliseconds
 */
export function formatIdleDuration(idleMs: number): string {
  if (idleMs < 60_000) return 'just now'
  if (idleMs < 3_600_000) return `${Math.floor(idleMs / 60_000)}m ago`
  if (idleMs < 86_400_000) return `${Math.floor(idleMs / 3_600_000)}h ago`
  return `${Math.floor(idleMs / 86_400_000)}d ago`
}
