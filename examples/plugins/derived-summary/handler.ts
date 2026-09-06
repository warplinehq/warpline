import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { skillFailure } from 'warpline/unstable-result'

// RED stub: loads, refuses, derives nothing. The GREEN commit replaces it.
export const handler: CapabilityHandlerFn = async (manifest, _args, _signal, _capabilities) => {
  return skillFailure('data_missing', `${manifest.name}: not implemented`, {
    phases_failed: [manifest.name],
    impact: 'HIGH',
    retryable: false,
  })
}
