#!/usr/bin/env node
/**
 * `warpline` bin entry — Node version gate, then hand off to the dispatcher.
 *
 * THIS FILE MUST HAVE NO STATIC IMPORTS. Not one. A static `import`
 * declaration is hoisted and its module graph is resolved BEFORE this
 * module's body executes, so a version check written above a static import
 * still produces the exact crash it exists to prevent — and only on the
 * machines that lack the feature, never on the maintainer's. On a Node below
 * the floor a static import of the dispatcher graph throws
 * ERR_UNKNOWN_FILE_EXTENSION with a resolver stack trace instead of the
 * readable required-vs-found line below.
 *
 * If you are here to "clean up" the dynamic import: don't. It is load-bearing.
 *
 * `engines.node` in package.json does NOT gate execution — npm emits a
 * warning at install time and nothing at run time. This is the actual gate.
 */

const REQUIRED_NODE = '^22.18.0 || >=23.6.0'

const [major, minor] = process.versions.node.split('.').map(Number)
const supported =
  (major === 22 && minor >= 18) || (major === 23 && minor >= 6) || major >= 24

if (!supported) {
  console.error(
    `warpline requires Node ${REQUIRED_NODE} — found ${process.versions.node}`,
  )
  process.exit(1)
}

const { main } = await import('../cli/warpline.js')
process.exit(await main(process.argv.slice(2)))
