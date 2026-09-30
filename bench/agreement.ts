/**
 * The rule that decides whether a private-scale figure may be published.
 *
 * A private set is compared with the public one through four ratios: the
 * warpline arm's median over each control's median, for wall-clock time and
 * for output tokens. A private figure is published only when every one of the
 * four agrees with its public counterpart. Otherwise the divergence is the
 * finding, and a set that fell short of the threshold is withheld.
 *
 * Pure and structural, like the statistics module. It takes plain summaries,
 * imports nothing, and reads no clock, file or environment, so a reader can run
 * it from literals.
 *
 * It lives in its own file because its bytes are frozen from the moment the
 * private method is committed. The rule a reader checks is then the rule that
 * ran, and a change to it shows up as a changed blob, not as a quiet edit to a
 * shared module.
 *
 * Every comparison is on the unrounded quotient of unrounded medians, with no
 * epsilon and strict inequalities. A ratio of exactly 1 is on neither side, and
 * a private ratio exactly one order of magnitude from the public one is not
 * within it. Both are disagreement.
 */

export type GatingRatioId =
  | 'wall_clock:agent-with-state'
  | 'wall_clock:agent-from-scratch'
  | 'output:agent-with-state'
  | 'output:agent-from-scratch'

type Measure = 'wall_clock' | 'output'
type Control = 'agent-with-state' | 'agent-from-scratch'

/** The four ratios, in the order every report lists them. */
export const GATING_RATIOS: readonly { id: GatingRatioId; measure: Measure; control: Control }[] = Object.freeze([
  Object.freeze({ id: 'wall_clock:agent-with-state', measure: 'wall_clock', control: 'agent-with-state' }),
  Object.freeze({ id: 'wall_clock:agent-from-scratch', measure: 'wall_clock', control: 'agent-from-scratch' }),
  Object.freeze({ id: 'output:agent-with-state', measure: 'output', control: 'agent-with-state' }),
  Object.freeze({ id: 'output:agent-from-scratch', measure: 'output', control: 'agent-from-scratch' }),
] as const)

export type RatioVerdict = 'agree' | 'diverge'

function requirePositive(x: number, what: string): void {
  if (!(Number.isFinite(x) && x > 0)) throw new Error(`agreement: ${what} must be finite and positive, got ${x}`)
}

/**
 * One private ratio against its public counterpart: strictly on the same side
 * of 1, and strictly less than one order of magnitude apart.
 */
export function agrees(priv: number, pub: number): RatioVerdict {
  if (!(Number.isFinite(priv) && priv > 0 && Number.isFinite(pub) && pub > 0)) {
    throw new Error(`agreement: a ratio must be finite and positive, got ${priv} vs ${pub}`)
  }
  const sameSide = (priv < 1 && pub < 1) || (priv > 1 && pub > 1)
  return sameSide && Math.abs(Math.log10(priv / pub)) < 1 ? 'agree' : 'diverge'
}

/** One arm, as much of it as the rule reads. An arm below the threshold has no median at all. */
export type ArmLike =
  | { median: { wall_clock_ms: number; tokens: { output: number } } }
  | { shortfall: { count: number; threshold: number } }

/** A whole set's summary, taken structurally. */
export interface SummaryLike {
  warpline: ArmLike
  'agent-with-state': ArmLike
  'agent-from-scratch': ArmLike
}

export interface Shortfall {
  arm: string
  count: number
  threshold: number
}

const ARMS = ['warpline', 'agent-with-state', 'agent-from-scratch'] as const

/**
 * The four ratios of one set, or every arm that fell short. No ratio is
 * computed over a set with a shortfall in any arm.
 */
export function gatingRatios(
  summary: SummaryLike,
): { ratios: Record<GatingRatioId, number> } | { shortfalls: Shortfall[] } {
  const shortfalls: Shortfall[] = []
  for (const arm of ARMS) {
    const a = summary[arm]
    if ('shortfall' in a) shortfalls.push({ arm, count: a.shortfall.count, threshold: a.shortfall.threshold })
  }
  if (shortfalls.length > 0) return { shortfalls }

  const medianOf = (arm: (typeof ARMS)[number], measure: Measure): number => {
    const a = summary[arm]
    if (!('median' in a)) throw new Error(`agreement: the ${arm} arm has no median`)
    return measure === 'wall_clock' ? a.median.wall_clock_ms : a.median.tokens.output
  }
  const ratios = {} as Record<GatingRatioId, number>
  for (const { id, measure, control } of GATING_RATIOS) {
    ratios[id] = medianOf('warpline', measure) / medianOf(control, measure)
  }
  return { ratios }
}

export interface AgreementReport {
  verdict: 'publish' | 'diverge' | 'withhold'
  ratios: { id: GatingRatioId; private: number; public: number; verdict: RatioVerdict }[]
  diverged: GatingRatioId[]
  shortfalls: Shortfall[]
}

/**
 * The verdict over a private set and the public one.
 *
 * A private shortfall withholds, naming each short arm and its count. A public
 * shortfall throws: the public set is the reference, and a caller handing in
 * one without medians has nothing to compare against.
 */
export function agreementVerdict(privateSummary: SummaryLike, publicSummary: SummaryLike): AgreementReport {
  const pub = gatingRatios(publicSummary)
  if (!('ratios' in pub)) throw new Error('agreement: the public set has no median to compare against')
  const priv = gatingRatios(privateSummary)
  if (!('ratios' in priv)) return { verdict: 'withhold', ratios: [], diverged: [], shortfalls: priv.shortfalls }

  const ratios = GATING_RATIOS.map(({ id }) => ({
    id,
    private: priv.ratios[id],
    public: pub.ratios[id],
    verdict: agrees(priv.ratios[id], pub.ratios[id]),
  }))
  const diverged = ratios.filter((r) => r.verdict === 'diverge').map((r) => r.id)
  return { verdict: diverged.length === 0 ? 'publish' : 'diverge', ratios, diverged, shortfalls: [] }
}

/** A ratio as it is published: two significant figures. */
export function twoSigFigs(x: number): string {
  requirePositive(x, 'a published ratio')
  return x.toPrecision(2)
}

/** An order of magnitude as it is published: the power of ten at or below it. */
export function powerOfTenBucket(x: number): number {
  requirePositive(x, 'an order of magnitude')
  return 10 ** Math.floor(Math.log10(x))
}
