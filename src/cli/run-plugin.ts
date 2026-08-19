#!/usr/bin/env bun
/**
 * Bun-side plugin executor for board-triggered guided tasks.
 *
 * The board (Node/tsx) cannot import .warpline/shared/invoke-plugin.ts directly
 * because it pulls in .warpline/schemas/ which are Bun-only modules.
 * This script provides a clean subprocess boundary:
 *
 *   Board (Node) → spawn('bun', ['run', 'scripts/run-plugin.ts', plugin, action])
 *   → reads JSON result from stdout
 *
 * Phase 121 D-35 — CLI parity with POST /api/run-plugin/:name:
 *   --retries=N  — override manifest.max_retries (integer in [0, 10])
 *   SIGINT       — propagates as AbortSignal to the handler (returns exit 130)
 *
 * Exit codes:
 *   0   — plugin executed successfully (check result.ok for logical success)
 *   1   — usage error or plugin execution threw
 *   130 — SIGINT received (conventional bash exit code)
 */
import { invokePlugin } from '../runtime/invoke-plugin'

const argv = process.argv.slice(2)
const retriesFlagIdx = argv.findIndex((a) => a.startsWith('--retries='))
let retriesOverride: number | undefined
if (retriesFlagIdx >= 0) {
  const parsed = parseInt(argv[retriesFlagIdx].split('=')[1], 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    console.error('Invalid --retries value; expected integer in [0, 10]')
    process.exit(1)
  }
  retriesOverride = parsed
}
const positional = argv.filter((a) => !a.startsWith('--'))
const [plugin, action] = positional

if (!plugin || !action) {
  console.error('Usage: bun run scripts/run-plugin.ts <plugin-name> <action-key> [--retries=N]')
  process.exit(1)
}

// SIGINT → AbortSignal fan-out (Phase 121 D-31/D-35).
const controller = new AbortController()
const onSigint = () => {
  controller.abort(new Error('SIGINT'))
  // Give the handler a tick to observe the abort before exiting.
  setTimeout(() => process.exit(130), 50)
}
process.on('SIGINT', onSigint)

try {
  const invocation = await invokePlugin(
    plugin,
    { action },
    {
      signal: controller.signal,
      maxRetriesOverride: retriesOverride,
      persistArtifact: true,
      userInitiated: true,
    },
  )
  const ok = invocation.result.status !== 'failed'
  const error = !ok
    ? invocation.result.errors?.[0]?.message ?? 'Plugin execution failed'
    : undefined

  // Structured JSON to stdout — board parses this.
  console.log(
    JSON.stringify({
      ok,
      error,
      duration_ms: invocation.duration_ms,
      attempt_count: invocation.attempt_count,
      cancelled: invocation.cancelled,
      timed_out: invocation.timed_out,
    }),
  )
} catch (err) {
  console.log(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  )
  process.exit(1)
}
