/**
 * Root barrel for the `warpline` package.
 *
 * Deliberately narrow: `runAdvance` plus the option/result types its signature
 * names. This is NOT a re-export of the runtime — every symbol here is public
 * contract from 0.1.0 onward, so the barrel stays at the size of the one entry
 * point a host actually calls. Sub-surfaces get their own `exports` subpath
 * (`warpline/schemas/*`, `warpline/lib/paths`, `warpline/unstable-runtime`).
 */
export { runAdvance } from './runtime/engine.js'
export type {
  AdvanceOptions,
  AdvanceResult,
  PluginFsmState,
  RunProfile,
} from './runtime/engine.js'
export type { HandlerFn } from './runtime/invoke-plugin.js'
