import { resolve } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Source shape, the same file anomaly-watch reads:
 * {
 *   "series": [
 *     { "name": "signup_rate", "latest": 3, "threshold": 5, "direction": "below" }
 *   ]
 * }
 *
 * This handler reads that file, derives a summary of it, and returns the
 * summary. It writes nothing: no cache of the answer, no record of the last
 * run, no memo. The answer is a function of the source alone, so running it
 * twice against the same file gives the same answer and the second run cost
 * one read. Whether that read is worth making again is the engine's call,
 * through `ttl_hours` on the manifest — docs/derive-dont-store.md is the
 * argument, and this file is the shape it argues for.
 */
interface Series {
  name: string
  latest: number
  threshold: number
  direction: 'above' | 'below'
}

function isSeries(s: unknown): s is Series {
  const v = s as Series
  return !!v && typeof v.name === 'string' && Number.isFinite(v.latest)
    && Number.isFinite(v.threshold) && (v.direction === 'above' || v.direction === 'below')
}

function isBreached(s: Series): boolean {
  return s.direction === 'above' ? s.latest > s.threshold : s.latest < s.threshold
}

/** The whole derivation: count, breached names, and the range of latest values. */
export function summarise(series: Series[]): string {
  if (series.length === 0) return '0 series'
  const breached = series.filter(isBreached).map(s => s.name)
  const values = series.map(s => s.latest)
  const range = `latest ${Math.min(...values)}..${Math.max(...values)}`
  return `${series.length} series, ${breached.length} breached`
    + (breached.length > 0 ? ` (${breached.join(', ')})` : '')
    + `, ${range}`
}

// `_signal` is accepted, unused — one local read has nothing to cancel.
export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  // A relative `source_path` resolves under the home, which is what lets
  // the manifest ship a placeholder default; an absolute one is honoured.
  const sourcePath = resolve(warplineHome(), typeof args.source_path === 'string' ? args.source_path : 'state/metrics.json')

  // `source_path` is operator-configured and this result lands in the run
  // log, so neither arm names it. ENOENT is "nothing to summarise yet";
  // anything else is a failure that names the input key and nothing more.
  let raw: { series?: unknown } | null
  try {
    raw = await readJsonOrNull<{ series?: unknown }>(sourcePath)
  } catch {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'source_path' is unreadable or not JSON`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
      retryable: false,
    })
  }
  if (raw === null) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and "no data yet" must not paint a red run.
    return skillOk(`${manifest.name}: no source file at the configured path — nothing to summarise`, {
      phases_completed: [manifest.name],
    })
  }

  const series = (Array.isArray(raw.series) ? raw.series : []).filter(isSeries)
  return skillOk(summarise(series), {
    phases_completed: [manifest.name],
    data_freshness: { summary: new Date().toISOString() },
  })
}
