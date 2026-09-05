/**
 * Emit the capability/effects table for docs/plugin-authoring.md from the
 * registry.
 *
 * A sibling of `gen-manifest-table.ts`, not an extension of it. Extending would
 * mean parameterising `DOC`/`BEGIN`/`END` and refactoring a file whose current
 * shape is a working gate; a second script wired into the same `docs:generate`
 * entry is the smaller diff, and CI's `git diff --exit-code -- docs/` already
 * covers any doc a generator writes.
 *
 * It generates only the mechanical facts — member name, the `side_effects`
 * entry a manifest must declare to receive it, and one line of description.
 * The prose around the region is hand-written and stays that way.
 *
 * Usage:
 *   bun run scripts/gen-capability-table.ts           # print the table
 *   bun run scripts/gen-capability-table.ts --write   # splice it into the doc
 *
 * CI runs --write and then `git diff --exit-code`, so a member added with a
 * stale doc fails the build instead of merging.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPABILITY_EFFECTS, CAPABILITY_REGISTRY } from '../src/runtime/capabilities.js'

const DOC = join(import.meta.dir, '..', 'docs', 'plugin-authoring.md')
const BEGIN = '<!-- generated: capability-effects -->'
const END = '<!-- /generated -->'

export function capabilityTable(): string {
  const names = Object.keys(CAPABILITY_REGISTRY)

  // An empty registry still renders headers and a row saying so. A zero-length
  // region reads as a stale pair of markers somebody forgot to fill, which is
  // indistinguishable from the omission the effects table exists to prevent.
  const rows =
    names.length === 0
      ? ['| — | — | No capability members are registered in this release. |']
      : names.map((name) => {
          const effect = CAPABILITY_EFFECTS[name]
          // `ungated` as a word, never an empty cell: an empty cell reads as an
          // omission, and omission is the one state a member cannot be in.
          const requires = effect === null ? '**ungated**' : `\`${effect}\``
          return `| \`${name}\` | ${requires} | ${CAPABILITY_REGISTRY[name].description} |`
        })

  return [
    BEGIN,
    '',
    '| Member | Requires `side_effects` entry | What it does |',
    '|---|---|---|',
    ...rows,
    '',
    END,
  ].join('\n')
}

if (import.meta.main) {
  const table = capabilityTable()
  if (!process.argv.includes('--write')) {
    console.log(table)
  } else {
    const doc = readFileSync(DOC, 'utf8')
    const start = doc.indexOf(BEGIN)
    const end = doc.indexOf(END, start)
    if (start === -1 || end === -1) {
      console.error(`FAIL: ${DOC} has no ${BEGIN} … ${END} region to write into`)
      process.exit(1)
    }
    writeFileSync(DOC, doc.slice(0, start) + table + doc.slice(end + END.length))
    console.log(
      `wrote ${Object.keys(CAPABILITY_REGISTRY).length} capability members into docs/plugin-authoring.md`,
    )
  }
}
