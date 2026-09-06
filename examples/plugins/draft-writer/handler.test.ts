import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { SkillResultSchema } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

const REFERENCE_KEYS = ['voice_rules_path', 'blocklist_path', 'frontmatter_schema_path'] as const
type ReferenceKey = (typeof REFERENCE_KEYS)[number]

/** The shipped default for a path input: where a `scaffold --from` copy puts the placeholder file. */
const shippedDefault = (key: ReferenceKey): string => manifest.inputs[key]?.default as string

/** The placeholder files as shipped, read from beside this test. */
async function shippedReference(key: ReferenceKey): Promise<string> {
  return readFile(join(import.meta.dir, 'reference', shippedDefault(key).split('/').at(-1)!), 'utf8')
}

function invoke(args: Record<string, unknown>) {
  return handler(manifest, args, new AbortController().signal, CONTEXT)
}

/**
 * `warpline/lib/paths` exports only `warplineHome`, which resolves
 * `WARPLINE_HOME` per call — the same seam a plugin author has. Each case
 * gets its own home and restores the suite's afterwards.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'draft-writer-'))
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
  }
}

/** Write a file at a home-relative path, creating the parent. */
async function seed(home: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(home, rel)), { recursive: true })
  await writeFile(join(home, rel), content)
}

/** The three shipped placeholders, at the shipped defaults, under `home`. */
async function seedShippedReferences(home: string, except?: ReferenceKey): Promise<void> {
  for (const key of REFERENCE_KEYS) {
    if (key !== except) await seed(home, shippedDefault(key), await shippedReference(key))
  }
}

/**
 * The whole home as `path|bytes|contents`, sorted: a full recursive walk with
 * no exclusion list, so "nothing written" is a statement about the whole
 * tree. Inline rather than hashed — `examples/` may not reach for
 * `node:crypto`.
 */
async function snapshot(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await snapshot(join(dir, entry.name), rel)))
    } else {
      const bytes = await readFile(join(dir, entry.name))
      out.push(`${rel}|${bytes.byteLength}|${bytes.toString('base64')}`)
    }
  }
  return out.sort()
}

const TOPICS = ['an example topic', 'a second example topic']

describe('draft-writer hands drafting off under the adopter\'s own reference files', () => {
  test('all three reference files present: a [needs-llm] handoff whose payload names the files and embeds none of them', async () => {
    await withHome(async (home) => {
      await seedShippedReferences(home)
      const result = await invoke({ topics: TOPICS })

      expect(result.status).toBe('skipped')
      expect(result.summary.startsWith('[needs-llm]')).toBe(true)
      // The structured arm proves the builder wrote this, not a literal.
      expect(result.needs_llm).toBeDefined()
      expect(/[.!?]$/.test(result.needs_llm?.task ?? '.')).toBe(false)
      expect(result.needs_llm?.task).toContain('2')
      expect(() => SkillResultSchema.parse(result)).not.toThrow()

      // The summary names the payload RESOLVED, and the payload is under the home.
      const [, tail] = result.summary.split('Context: ')
      expect(tail).toBe(join(home, result.needs_llm!.context_path))
      const payloadText = await readFile(tail!, 'utf8')
      const payload = JSON.parse(payloadText) as {
        topics: string[]
        draft_length_words: number
        output_dir: string
        references: Record<string, string>
      }
      expect(payload.topics).toEqual(TOPICS)
      expect(payload.draft_length_words).toBe(800)
      expect(payload.output_dir).toBe('drafts/draft-writer')
      // By path, relative to the home — never by content.
      expect(payload.references).toEqual({
        voice_rules: shippedDefault('voice_rules_path'),
        blocklist: shippedDefault('blocklist_path'),
        frontmatter_schema: shippedDefault('frontmatter_schema_path'),
      })
      for (const key of REFERENCE_KEYS) {
        const firstLine = (await shippedReference(key)).split('\n')[0]!
        expect(payloadText).not.toContain(firstLine)
      }
      expect(payloadText).not.toContain('example-forbidden-term')
    })
  })

  test('a reference path that is absolute, carries a drive letter or climbs out is refused before any read, naming the key and the rule', async () => {
    await withHome(async (home) => {
      // NO reference file exists in this home. A refusal that says "missing"
      // would prove the read happened; a `failed` naming the rule proves the
      // shape was checked first.
      const before = await snapshot(home)
      for (const key of [...REFERENCE_KEYS, 'output_dir'] as const) {
        for (const outside of ['/tmp/elsewhere/rules.md', 'C:\\elsewhere\\rules.md', 'plugins/../../elsewhere/rules.md']) {
          const result = await invoke({ topics: TOPICS, [key]: outside })
          expect(result.status).toBe('failed')
          expect(result.summary).toContain(`'${key}'`)
          expect(result.summary).toContain('warpline home')
          expect(result.summary).not.toContain('elsewhere')
        }
      }
      expect(await snapshot(home)).toEqual(before)
    })
  })

  test('a missing reference file is a prefixed skip naming the key and telling the adopter to point it somewhere, never a failure', async () => {
    for (const key of REFERENCE_KEYS) {
      await withHome(async (home) => {
        await seedShippedReferences(home, key)
        const before = await snapshot(home)
        const result = await invoke({ topics: TOPICS })

        // A prefix-less `skipped` is persisted as `failed`; an unconfigured
        // plugin is not a broken one.
        expect(result.status).not.toBe('skipped')
        expect(result.status).toBe('success')
        expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
        expect(result.summary).toContain(`'${key}'`)
        expect(result.summary).toContain('point')
        expect(result.summary.startsWith('[needs-llm]')).toBe(false)
        expect(await snapshot(home)).toEqual(before)
      })
    }
  })

  test('no topics — the shipped default — is a prefixed skip naming the key and the configuring invocation', async () => {
    await withHome(async (home) => {
      await seedShippedReferences(home)
      const before = await snapshot(home)
      const result = await invoke({})

      expect(result.status).toBe('success')
      expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(result.summary).toContain("'topics'")
      expect(result.summary).toContain('warpline configure draft-writer')
      expect(await snapshot(home)).toEqual(before)
    })
  })

  test('a blocklist that is not JSON, or not the documented shape, is a failure naming the key', async () => {
    await withHome(async (home) => {
      await seedShippedReferences(home)
      await seed(home, shippedDefault('blocklist_path'), '{"terms": [')
      const broken = await invoke({ topics: TOPICS })
      expect(broken.status).toBe('failed')
      expect(broken.errors?.[0]?.code).toBe('parse_error')
      expect(broken.summary).toContain("'blocklist_path'")

      await seed(home, shippedDefault('blocklist_path'), '{"words": []}')
      const misshapen = await invoke({ topics: TOPICS })
      expect(misshapen.status).toBe('failed')
      expect(misshapen.summary).toContain("'blocklist_path'")
      expect(misshapen.summary).toContain('terms')
    })
  })
})

/**
 * Zero content ships in the handler. Two halves: the source reads exactly the
 * declared inputs and nothing it does not declare, and none of the shipped
 * placeholder content is written into it; and at run time, whatever the
 * adopter's files hold reaches neither the result nor the payload.
 */
describe('draft-writer carries no content of its own', () => {
  test('the handler reads every declared input and nothing else, and none of the reference material appears in its source', async () => {
    const source = await readFile(join(import.meta.dir, 'handler.ts'), 'utf8')
    const read = new Set<string>()
    for (const m of source.matchAll(/configured\(manifest, args, '(\w+)'\)/g)) read.add(m[1]!)
    for (const m of source.matchAll(/\bargs\.(\w+)/g)) read.add(m[1]!)
    for (const m of source.matchAll(/\bargs\[['"](\w+)['"]\]/g)) read.add(m[1]!)
    const declared = Object.keys(manifest.inputs).sort()
    // Both directions: an undeclared read is config the manifest hides, and a
    // declared input nobody reads is decoration.
    expect([...read].sort()).toEqual(declared)

    const blocklist = JSON.parse(await shippedReference('blocklist_path')) as { terms: string[] }
    const schema = JSON.parse(await shippedReference('frontmatter_schema_path')) as { fields: Record<string, string> }
    const rules = (await shippedReference('voice_rules_path')).split('\n').filter((l) => l.startsWith('- '))
    expect(blocklist.terms.length).toBeGreaterThan(0)
    expect(rules.length).toBeGreaterThan(0)
    for (const term of blocklist.terms) expect(source).not.toContain(term)
    for (const rule of rules) expect(source).not.toContain(rule.slice(2))
    for (const field of Object.keys(schema.fields)) expect(source).not.toContain(`'${field}'`)
  })

  test('whatever the adopter\'s files hold reaches neither the result nor the payload', async () => {
    const SENTINEL = 'do-not-embed-4f2a'
    await withHome(async (home) => {
      await seed(home, shippedDefault('voice_rules_path'), `# ${SENTINEL} rules\n- never say ${SENTINEL}\n`)
      await seed(home, shippedDefault('blocklist_path'), JSON.stringify({ terms: [SENTINEL] }))
      await seed(home, shippedDefault('frontmatter_schema_path'), JSON.stringify({ fields: { [SENTINEL]: 'string' } }))
      const result = await invoke({ topics: TOPICS })

      expect(result.status).toBe('skipped')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      const payload = await readFile(result.summary.split('Context: ')[1]!, 'utf8')
      expect(payload).not.toContain(SENTINEL)
    })
  })

  test('the three shipped reference files are recognisable placeholders that say so on their first line', async () => {
    for (const key of REFERENCE_KEYS) {
      const firstLine = (await shippedReference(key)).split('\n')[0]!
      expect(firstLine.toLowerCase()).toContain('example')
      expect(firstLine.toLowerCase()).toContain('replace')
    }
    const blocklist = JSON.parse(await shippedReference('blocklist_path')) as { terms: string[] }
    for (const term of blocklist.terms) expect(term).toMatch(/example|placeholder/)
    // The shipped defaults are what the provenance guard admits: relative,
    // under the home, and named as examples.
    for (const key of REFERENCE_KEYS) {
      expect(shippedDefault(key).startsWith('plugins/draft-writer/reference/')).toBe(true)
      expect(shippedDefault(key)).toContain('example')
    }
  })
})

/**
 * Every path arrives from `<home>/config/draft-writer.json` and every
 * summary lands in the run log, so no arm names the value it was handed.
 * The sentinel sits in a DIRECTORY name, so it rides the resolved path into
 * whatever an arm interpolates.
 */
describe('draft-writer config value disclosure', () => {
  const SENTINEL = 'do-not-echo-1c9e'

  test('a configured path never reaches the result, whether refused, missing or present', async () => {
    await withHome(async (home) => {
      const refused = await invoke({ topics: TOPICS, voice_rules_path: `/tmp/${SENTINEL}/rules.md` })
      expect(refused.status).toBe('failed')
      expect(JSON.stringify(refused)).not.toContain(SENTINEL)

      await seedShippedReferences(home)
      const missing = await invoke({ topics: TOPICS, blocklist_path: `plugins/${SENTINEL}/blocklist.json` })
      expect(missing.status).toBe('success')
      expect(JSON.stringify(missing)).not.toContain(SENTINEL)

      const relocated: Record<string, string> = {}
      for (const key of REFERENCE_KEYS) {
        relocated[key] = `plugins/${SENTINEL}/${shippedDefault(key).split('/').at(-1)}`
        await seed(home, relocated[key]!, await shippedReference(key))
      }
      const present = await invoke({ topics: TOPICS, ...relocated, output_dir: `drafts/${SENTINEL}` })
      expect(present.status).toBe('skipped')
      expect(present.summary.startsWith('[needs-llm]')).toBe(true)
      // The whole result, errors[] and the handoff included: the Context path
      // is the payload this plugin writes, never a path it was configured with.
      expect(JSON.stringify(present)).not.toContain(SENTINEL)
    })
  })
})
