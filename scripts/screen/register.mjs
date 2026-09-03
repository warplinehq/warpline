/**
 * Installs the extensionless-`.ts` resolve hook for the screen's Node leg.
 *
 * Separate from `resolve-ts.mjs` because `module.register` loads the hook into
 * its own thread: the file that registers cannot also BE the hook.
 */
import { register } from 'node:module'
register('./resolve-ts.mjs', import.meta.url)
