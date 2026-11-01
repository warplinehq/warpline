/**
 * The shapes every renderer returns, and the one rule turning a float USD into
 * integer micro-USD.
 *
 * This directory is the only code in warpline that talks to a model, and
 * nothing the engine imports may reach it.
 */

/** Where a cost came from: the provider said it, the price table gave it, or nobody knows. */
export type CostBasis = 'reported' | 'computed' | 'unknown'

/** USD per million tokens, keyed by the requested model. */
export type PriceTable = Readonly<Record<string, { usd_per_mtok_in: number; usd_per_mtok_out: number }>>

export type Rendered = {
  ok: boolean
  text: string | null
  served: string | null
  cost_micro_usd: number | null
  cost_basis: CostBasis
  reason: string | null
}

/** Round a float USD up to whole micro-USD. */
export function toMicroUp(usd: number): number {
  // A plain Math.ceil(usd * 1e6) overcounts exact decimals: 0.000123 becomes 124.
  return Math.ceil(Math.round(usd * 1e9) / 1e3)
}
