import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { skillFailure } from 'warpline/unstable-result'

// RED stub: the tests beside this file describe the fan-in act; nothing here
// performs it yet.
export const handler: CapabilityHandlerFn = async (manifest, _args, _signal, _capabilities) => {
  return skillFailure('data_missing', `${manifest.name}: not implemented`, { phases_failed: [manifest.name] })
}
