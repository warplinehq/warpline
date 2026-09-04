#!/usr/bin/env node
/**
 * Screen every manifest under a plugin root for import-time side effects.
 *
 * WHY THIS EXISTS. `runAdvance` loads every manifest under the plugin root at
 * the top of the function, above the quiet-hours early return — so a cycle that
 * does no work still imports the whole roster. That is published behaviour as
 * of 0.3.3 and cannot be withdrawn, which makes "what does importing this
 * roster actually do" a question a host operator has to be able to answer for
 * their own tree. This answers it by importing each manifest for real, under
 * traps, rather than by reading the files and forming an opinion.
 *
 * It replaces a static text scan. A static scan cannot see a side effect
 * reached through a construct it does not tokenise; this cannot see one that
 * does not happen on the machine it runs on. The second limit is the smaller
 * one, and unlike the first it is visible in the output.
 *
 *   node scripts/screen-plugin-root.mjs <plugin-root> [--json]
 *
 * Exit 0 when every manifest is declarative, 1 when any is dirty or the screen
 * could not screen it. "Could not screen" is a FAILURE, never a pass: a screen
 * that reports clean for a file it never loaded is the exact shape of guard
 * this repository has already been burned by.
 *
 * WHAT IT DOES NOT COVER, stated so the record does not overclaim:
 *   - Handlers. They are not imported at manifest-load time, so they are not
 *     part of this exposure. Screening them would be answering a different
 *     question.
 *   - Behaviour conditional on something absent here — a clock, an env var, a
 *     file that exists only in production.
 *   - Anything a manifest does on a runtime this did not run on. The roster is
 *     loaded by bun in production and by Node here, because Node is the only
 *     one of the two with a permission model. A manifest branching on
 *     `process.versions.bun` would be screened on the branch not taken; the
 *     summary says so rather than leaving it to be discovered.
 */
import { readdir, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

// REFUSES TO RUN UNDER BUN, and this is the most important line in the file.
//
// Every trap here is Node-specific: `--permission` is a Node flag, and
// `process.getActiveResourcesInfo()` is a Node API. Run under bun, the flags
// are ignored and the deferred-work check reads empty — so a manifest that
// writes at import time comes back `declarative`. Measured, not feared: the
// deferred fixture screens `dirty` under node and `declarative` under bun.
//
// That is a SILENT FALSE GREEN in a guard whose whole purpose is to not be one,
// and it is reachable by accident — `bun` is this project's primary runtime,
// and a test harness spawning `process.execPath` under `bun test` picks bun
// without anyone deciding to. Which is exactly how it was found.
if (process.versions.bun) {
  console.error(
    'screen-plugin-root: refusing to run under bun.\n' +
      '  This screen depends on `node --permission` and `process.getActiveResourcesInfo()`.\n' +
      '  Under bun both are absent, the traps silently do nothing, and a manifest that\n' +
      '  writes at import time is reported `declarative`. Run it with node:\n' +
      '      node scripts/screen-plugin-root.mjs <plugin-root>',
  )
  process.exit(2)
}

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD = join(HERE, 'screen', 'child.mjs')
const REGISTER = join(HERE, 'screen', 'register.mjs')

/** Per-manifest timeout. A manifest that never finishes importing is DIRTY. */
const TIMEOUT_MS = 20_000

/**
 * Candidate entries, matching `loadPluginManifests`'s own rule exactly:
 * directories, and symlinks that resolve to one. Screening a different set
 * than the engine loads would answer a question nobody asked.
 */
async function candidates(root) {
  const dirents = await readdir(root, { withFileTypes: true })
  const out = []
  for (const d of dirents) {
    if (d.isDirectory()) {
      out.push(d.name)
    } else if (d.isSymbolicLink()) {
      try {
        if ((await stat(join(root, d.name))).isDirectory()) out.push(d.name)
      } catch {
        /* dangling: not a candidate, exactly as the loader treats it */
      }
    }
  }
  return out.sort()
}

async function screenOne(root, name) {
  const manifest = join(root, name, 'manifest.ts')
  const args = [
    '--permission',
    // Required for the resolve hook, which runs on a loader thread. Verified
    // by fixture NOT to open an fs-write escape: a manifest spawning a worker
    // that writes still has the write denied, and the Worker construction is
    // itself recorded.
    '--allow-worker',
    // Reads are wide on purpose. Reading is not the side effect under test,
    // and a narrow read allowlist would fail manifests for resolving their own
    // imports — dirty for the wrong reason, which is worse than not screening.
    '--allow-fs-read=*',
    // NO --allow-fs-write, and no --allow-child-process. That absence IS the trap.
    '--import',
    REGISTER,
    CHILD,
    manifest,
  ]
  // A nonce the manifest cannot learn: the child deletes it from env and argv
  // before importing. Without this, a manifest whose first line printed a
  // lookalike verdict DICTATED ITS OWN — verified against a fixture that
  // screened `declarative` while writing a file.
  const nonce = randomUUID()
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, __WARPLINE_SCREEN_NONCE: nonce },
    })
    const line = stdout.split('\n').find((l) => l.startsWith(nonce + ' '))
    if (!line) return { name, verdict: 'unscreenable', reason: 'child emitted no authentic verdict line' }
    const r = JSON.parse(line.slice(nonce.length + 1))
    if (r.outcome === 'import-failed') {
      return { name, verdict: 'unscreenable', reason: `import failed: ${r.error}` }
    }
    const real = r.hits.filter((h) => h.kind !== 'stdio')
    const defects = r.hits.filter((h) => h.kind === 'screen-defect')
    if (defects.length) {
      return { name, verdict: 'unscreenable', reason: defects.map((d) => d.detail).join('; ') }
    }
    const stdio = r.hits.filter((h) => h.kind === 'stdio')
    // Deferred work is work. A manifest that schedules a write for after import
    // left a Timeout behind and screened `declarative` — the child had always
    // collected `handles`, and the parent had always thrown them away. Evidence
    // gathered and discarded is worse than evidence not gathered: it reads as
    // covered.
    const handles = (r.handles ?? []).filter((h) => h !== 'PipeWrap')
    if (real.length === 0 && stdio.length === 0 && handles.length === 0) {
      return { name, verdict: 'declarative', hits: [] }
    }
    return {
      name,
      verdict: real.length || handles.length ? 'dirty' : 'dirty-stdio',
      hits: [
        ...real.map((h) => `${h.kind}: ${h.detail}`),
        ...handles.map((h) => `deferred: left a ${h} pending after import`),
        ...stdio.map((h) => `${h.kind}: ${h.detail}`),
      ],
    }
  } catch (err) {
    if (err.killed || err.signal) {
      return { name, verdict: 'dirty', hits: [`timeout: import did not settle in ${TIMEOUT_MS}ms`] }
    }
    return { name, verdict: 'unscreenable', reason: String(err.message).slice(0, 300) }
  }
}

const root = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  console.error('usage: node scripts/screen-plugin-root.mjs <plugin-root> [--json]')
  process.exit(2)
}

const names = await candidates(root)
const results = []
for (const n of names) results.push(await screenOne(root, n))

const dirty = results.filter((r) => r.verdict.startsWith('dirty'))
const unscreenable = results.filter((r) => r.verdict === 'unscreenable')

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ root, count: results.length, results }, null, 2))
} else {
  console.log(`\nplugin root: ${root}`)
  console.log(`runtime:     node ${process.versions.node} (--permission, no --allow-fs-write)\n`)
  for (const r of results) {
    const mark = r.verdict === 'declarative' ? '  ' : '! '
    console.log(`${mark}${r.name.padEnd(34)} ${r.verdict}${r.reason ? ` — ${r.reason}` : ''}`)
    for (const h of r.hits ?? []) console.log(`      ${h}`)
  }
  console.log(
    `\n${results.length} screened · ${results.length - dirty.length - unscreenable.length} declarative · ` +
      `${dirty.length} dirty · ${unscreenable.length} unscreenable`,
  )
}

process.exit(dirty.length + unscreenable.length > 0 ? 1 : 0)
