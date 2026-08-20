/**
 * Emit the manifest field table for docs/runtime-spec.md from the schema.
 *
 * Generates only the mechanical facts — field name, type, required, default —
 * which are exactly what drifts and exactly what a reader looks up. Semantic
 * prose stays in the schema's JSDoc, where TypeScript users see it on hover,
 * rather than being relocated into `.meta()` and duplicated. Diataxis makes the
 * same point about reference: keep it austere, link out for the why.
 *
 * Usage:
 *   bun run scripts/gen-manifest-table.ts           # print the table
 *   bun run scripts/gen-manifest-table.ts --write   # splice it into the doc
 *
 * CI runs --write and then `git diff --exit-code`, so a schema change with a
 * stale doc fails the build instead of merging.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PluginManifestSchema } from '../src/schemas/plugin-manifest.js'

const DOC = join(import.meta.dir, '..', 'docs', 'runtime-spec.md')
const BEGIN = '<!-- generated: manifest-fields -->'
const END = '<!-- /generated -->'

/** A readable type name for a field, from its JSON Schema projection. */
function typeName(node: Record<string, unknown>): string {
  if (Array.isArray(node['enum'])) return (node['enum'] as unknown[]).map((v) => `\`${v}\``).join(' \\| ')
  if (node['type'] === 'array') {
    const items = (node['items'] ?? {}) as Record<string, unknown>
    const inner = typeName(items)
    // Parenthesise a union inside an array: `a | b[]` reads as "a, or b[]".
    return Array.isArray(items['enum']) ? `(${inner})[]` : `${inner}[]`
  }
  if (node['type'] === 'object') return 'object'
  if (node['type'] === 'integer') return 'integer'
  return typeof node['type'] === 'string' ? (node['type'] as string) : 'unknown'
}

export function manifestTable(): string {
  // `io: 'input'` describes what an author WRITES in a manifest — fields with
  // defaults are optional on the way in. The output projection would mark them
  // required, which is true of the parsed value and false of the file, and the
  // file is what this table documents.
  const schema = z.toJSONSchema(PluginManifestSchema, { io: 'input' }) as {
    properties: Record<string, Record<string, unknown>>
    required?: string[]
  }
  const required = new Set(schema.required ?? [])

  const rows = Object.keys(PluginManifestSchema.shape).map((name) => {
    const node = schema.properties[name] ?? {}
    const dflt = node['default']
    return `| \`${name}\` | ${typeName(node)} | ${required.has(name) ? 'yes' : 'no'} | ${
      dflt === undefined ? '—' : `\`${JSON.stringify(dflt)}\``
    } |`
  })

  return [
    BEGIN,
    '',
    '| Field | Type | Required | Default |',
    '|---|---|---|---|',
    ...rows,
    '',
    END,
  ].join('\n')
}

if (import.meta.main) {
  const table = manifestTable()
  if (!process.argv.includes('--write')) {
    console.log(table)
  } else {
    const doc = readFileSync(DOC, 'utf8')
    const start = doc.indexOf(BEGIN)
    const end = doc.indexOf(END)
    if (start === -1 || end === -1) {
      console.error(`FAIL: ${DOC} has no ${BEGIN} … ${END} region to write into`)
      process.exit(1)
    }
    writeFileSync(DOC, doc.slice(0, start) + table + doc.slice(end + END.length))
    console.log(`wrote ${Object.keys(PluginManifestSchema.shape).length} fields into docs/runtime-spec.md`)
  }
}
