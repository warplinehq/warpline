import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { skillFailure } from 'warpline/unstable-result'

// RED stub: the tests beside this file describe the handoff and the in-home
// rule; nothing here performs either yet.
export const handler: CapabilityHandlerFn = async (manifest, _args, _signal, _capabilities) => {
  return skillFailure('data_missing', `${manifest.name}: not implemented`, { phases_failed: [manifest.name] })
}
