/**
 * RED-phase stub. Signatures only, so the tests fail on their own assertions
 * rather than on a module that cannot be loaded — a load crash proves nothing
 * about the behaviour being specified. Replaced wholesale by the GREEN commit.
 */

export function type7Quantile(_values: readonly number[], _p: number): number {
  return Number.NaN
}

export function median(values: readonly number[]): number {
  return type7Quantile(values, 0.5)
}

export function iqr(values: readonly number[]): number {
  return type7Quantile(values, 0.75) - type7Quantile(values, 0.25)
}
