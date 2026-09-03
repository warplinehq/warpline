/**
 * Screen one manifest for import-time side effects, in a child process.
 *
 * Imports the manifest and reports what it did while loading. The parent reads
 * the single JSON line on stdout; anything else on stdout or stderr is the
 * manifest's own noise and is captured as evidence, not as the verdict.
 *
 * Two traps, deliberately layered, because neither alone is enough:
 *
 *   1. `node --permission` with no `--allow-fs-write` (the parent supplies the
 *      flags). Filesystem writes throw `ERR_ACCESS_DENIED` from inside the
 *      runtime. This is the authoritative fs trap: it cannot be evaded by an
 *      import form, because it is not implemented in JavaScript.
 *   2. The JS traps below, for the surfaces the permission model does not cover
 *      — network, environment mutation, `process.exit`, and stdio writes.
 *
 * The layering is the point. The static screen this replaces could not see a
 * side effect reached through a construct it did not tokenise; a monkeypatch
 * screen cannot see one reached through an import form it did not patch. The
 * permission model has neither blind spot for the filesystem, which is the
 * surface that actually matters for a manifest load.
 */
const hits = []
const note = (kind, detail) => hits.push({ kind, detail: String(detail).slice(0, 300) })

// --- filesystem: DETECTION, layered under the permission model's PREVENTION -
//
// The permission model stops a write from happening. It does not report the
// ATTEMPT: a manifest that wraps its write in a try/catch swallows the
// `ERR_ACCESS_DENIED` and loads looking clean — verified against a fixture that
// does exactly that. Prevention is not detection, and the question this screen
// answers is what a manifest WOULD do in production, where there is no
// permission model at all.
//
// So the write functions are wrapped to record intent before the runtime
// refuses it.
//
// On `syncBuiltinESMExports()`, measured rather than assumed: patching the CJS
// module object is enough on its own here. Node 24's ESM named bindings for
// builtins are already live views of it, so `import { writeFileSync } from
// 'node:fs'` sees the wrapper with the sync calls REMOVED — checked by
// disabling all of them and confirming the named-import and swallowed-write
// fixtures still go red. The calls are kept because they are the documented
// API for exactly this and the liveness is not a guarantee across Node
// versions, but they are a safeguard, not the mechanism. Saying otherwise is
// how the first version of this file came to describe a mechanism it did not
// have.
// Patched through `createRequire`, NOT through the ESM namespace. A module
// namespace object reports `writable: true` and still throws on assignment —
// ESM is strict mode and its [[Set]] always fails. The first version of this
// file assigned to the namespace inside a try/catch, so every patch silently
// failed and the catch hid it; the fixtures still went red, but via the
// permission model, and the file claimed a mechanism it did not have. The CJS
// module object IS mutable, and `syncBuiltinESMExports()` republishes it to the
// ESM named bindings — that pair is the only thing that reaches every import
// form.
import { createRequire, syncBuiltinESMExports } from 'node:module'
const require_ = createRequire(import.meta.url)
const fsMod = require_('node:fs')
const fspMod = require_('node:fs/promises')

const WRITE_FNS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rename', 'renameSync',
  'copyFile', 'copyFileSync', 'open', 'openSync', 'createWriteStream', 'truncate',
  'truncateSync', 'chmod', 'chmodSync', 'symlink', 'symlinkSync',
]
for (const mod of [fsMod, fspMod]) {
  for (const name of WRITE_FNS) {
    const real = mod[name]
    if (typeof real !== 'function') continue
    try {
      mod[name] = function (...args) {
        // `open`/`openSync` are read paths too — only a writable flag counts.
        if (name.startsWith('open')) {
          const flag = args[1]
          if (flag === undefined || flag === 'r') return real.apply(this, args)
        }
        note('fs', `${name}(${String(args[0]).slice(0, 120)})`)
        return real.apply(this, args)
      }
    } catch (patchErr) {
      // A patch that cannot be installed is recorded, never swallowed. The
      // first version of this file hid exactly this and reported a mechanism
      // it did not have.
      note('screen-defect', `could not wrap ${name}: ${patchErr.message}`)
    }
  }
}
syncBuiltinESMExports()

// --- worker_threads --------------------------------------------------------
//
// A worker runs on its own thread with its OWN module registry, so the patches
// above do not reach inside one. Found by fixture: a manifest spawning a worker
// that writes and swallows the denial screened clean through every other trap
// here. The permission model still CONTAINED it — no file appeared — but a
// screen that reports "clean" for a manifest which tried is not telling the
// truth about what it would do in production.
//
// So the construction is the finding. A manifest has no business starting a
// thread while merely being read for its shape, whatever the thread then does.
const wtMod = require_('node:worker_threads')
const RealWorker = wtMod.Worker
if (typeof RealWorker === 'function') {
  try {
    wtMod.Worker = class extends RealWorker {
      constructor(...args) {
        note('worker_threads', `new Worker(${String(args[0]).slice(0, 120)})`)
        super(...args)
      }
    }
  } catch (patchErr) {
    note('screen-defect', `could not wrap Worker: ${patchErr.message}`)
  }
}
syncBuiltinESMExports()

// --- child_process ---------------------------------------------------------
const cpMod = require_('node:child_process')
for (const name of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cpMod[name]
  if (typeof real !== 'function') continue
  try {
    cpMod[name] = function (...args) {
      note('child_process', `${name}(${String(args[0]).slice(0, 120)})`)
      return real.apply(this, args)
    }
  } catch (patchErr) {
    note('screen-defect', `could not wrap child_process.${name}: ${patchErr.message}`)
  }
}
syncBuiltinESMExports()

// --- stdio -----------------------------------------------------------------
// A manifest that prints at import time is doing work at import time. Captured
// rather than blocked, so the manifest still runs to completion and later
// surfaces are still exercised.
for (const stream of ['stdout', 'stderr']) {
  const original = process[stream].write.bind(process[stream])
  process[stream].write = (chunk, ...rest) => {
    note('stdio', `${stream}: ${typeof chunk === 'string' ? chunk : '<buffer>'}`)
    return original(chunk, ...rest)
  }
}

// --- network ---------------------------------------------------------------
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch
  globalThis.fetch = (...args) => {
    note('network', `fetch ${args[0]}`)
    return realFetch(...args)
  }
}

// --- environment -----------------------------------------------------------
// `process.env` is reassignable and its members are settable, so a Proxy is the
// only way to see a write. Reads are allowed and unrecorded: reading config is
// not a side effect.
const realEnv = process.env
process.env = new Proxy(realEnv, {
  set(target, prop, value) {
    note('env', `set ${String(prop)}`)
    target[prop] = value
    return true
  },
  deleteProperty(target, prop) {
    note('env', `delete ${String(prop)}`)
    delete target[prop]
    return true
  },
})

// --- process.exit ----------------------------------------------------------
// A manifest calling exit at import time would otherwise take the verdict with
// it — the parent would see a dead child and no JSON line.
const realExit = process.exit.bind(process)
process.exit = (code) => {
  note('process', `process.exit(${code})`)
  report('exited')
  realExit(0)
}

let reported = false
function report(outcome, error) {
  if (reported) return
  reported = true
  // Restore the real write: the trap above would otherwise record the verdict
  // line itself as a stdio side effect of the manifest.
  process.stdout.write = Object.getPrototypeOf(process.stdout).write.bind(process.stdout)
  const handles = (process.getActiveResourcesInfo?.() ?? []).filter(
    (r) => !['TTYWrap', 'Immediate', 'TickObject', 'SignalWrap'].includes(r),
  )
  process.stdout.write(
    JSON.stringify({ __screen__: true, outcome, hits, handles, error: error ?? null }) + '\n',
  )
}

const target = process.argv[2]
try {
  await import(target)
  report('loaded')
} catch (err) {
  // ERR_ACCESS_DENIED is the permission model refusing a write — that is a
  // side effect DETECTED, not a screen failure, and it is recorded as such.
  const code = err?.code ?? ''
  if (String(code).includes('ERR_ACCESS_DENIED')) {
    note('fs', `permission model denied: ${err.message}`)
    report('loaded-with-denial')
  } else {
    report('import-failed', `${code} ${err?.message ?? err}`)
  }
}
