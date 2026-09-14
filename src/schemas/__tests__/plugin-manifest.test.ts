import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  PluginManifestSchema,
  AutonomyLevel,
  SideEffectType,
} from '../plugin-manifest.js'

const validManifest = {
  name: 'keyword-research',
  version: '1.0.0',
  description: 'Fetches keyword data from GSC and aggregates search metrics',
  inputs: {
    site_url: { type: 'string', required: true, description: 'Site URL to inspect' },
  },
  outputs: {
    keywords_json: { type: 'string', description: 'Path to output JSON' },
  },
  capabilities: ['network_read', 'file_write'],
  schedule: 'weekly' as const,
  autonomy_level: 'autonomous' as const,
  side_effects: ['modifies_file'] as const,
  ttl_hours: 168,
  dependencies: ['gsc-auth'],
  timeout_ms: 30_000,
  max_parallelism: 1,
}

describe('PluginManifestSchema', () => {
  test('Test 1: Valid manifest with all fields parses successfully', () => {
    const result = PluginManifestSchema.parse(validManifest)
    expect(result.name).toBe('keyword-research')
    expect(result.version).toBe('1.0.0')
    expect(result.autonomy_level).toBe('autonomous')
    expect(result.ttl_hours).toBe(168)
    expect(result.side_effects).toEqual(['modifies_file'])
  })

  test('Test 2: Missing name field throws ZodError', () => {
    const { name: _name, ...noName } = validManifest
    expect(() => PluginManifestSchema.parse(noName)).toThrow(z.ZodError)
  })

  test('Test 3: Invalid autonomy_level value throws ZodError', () => {
    expect(() =>
      PluginManifestSchema.parse({ ...validManifest, autonomy_level: 'automatic' })
    ).toThrow(z.ZodError)
  })

  test('Test 4: Invalid side_effects value throws ZodError', () => {
    expect(() =>
      PluginManifestSchema.parse({ ...validManifest, side_effects: ['sends_teleport'] })
    ).toThrow(z.ZodError)
  })

  test('Test 5: Empty dependencies array is valid', () => {
    const result = PluginManifestSchema.parse({ ...validManifest, dependencies: [] })
    expect(result.dependencies).toEqual([])
  })

  test('Test 6: ttl_hours must be positive number', () => {
    expect(() =>
      PluginManifestSchema.parse({ ...validManifest, ttl_hours: 0 })
    ).toThrow(z.ZodError)
    expect(() =>
      PluginManifestSchema.parse({ ...validManifest, ttl_hours: -1 })
    ).toThrow(z.ZodError)
  })

  test('Test 7: .parse() is used (not .safeParse()) — invalid manifests hard-stop', () => {
    // Validate that the schema itself throws (doesn't silently return {success: false})
    const bad = { ...validManifest, name: '' }
    let threw = false
    try {
      PluginManifestSchema.parse(bad)
    } catch (e) {
      threw = true
      expect(e).toBeInstanceOf(z.ZodError)
    }
    expect(threw).toBe(true)
  })
})

describe('SideEffectType enum', () => {
  test('All valid side effect types are accepted', () => {
    const types: z.infer<typeof SideEffectType>[] = [
      'sends_email', 'creates_issue', 'writes_db', 'external_api', 'modifies_file',
    ]
    for (const t of types) {
      expect(() => SideEffectType.parse(t)).not.toThrow()
    }
  })
})

describe('AutonomyLevel enum', () => {
  test('All valid autonomy levels are accepted', () => {
    const levels: z.infer<typeof AutonomyLevel>[] = ['autonomous', 'supervised', 'manual']
    for (const l of levels) {
      expect(() => AutonomyLevel.parse(l)).not.toThrow()
    }
  })
})

// ── Output temporality (R6) ──────────────────────────────────────────────

describe('outputs.temporality', () => {
  const withOutputs = (outputs: Record<string, unknown>) => ({ ...validManifest, outputs })

  test('an outputs entry omitting temporality reads replace', () => {
    const parsed = PluginManifestSchema.parse(
      withOutputs({ keywords_json: { type: 'string', description: 'Path to output JSON' } }),
    )
    expect(parsed.outputs['keywords_json']?.temporality).toBe('replace')
  })

  test("an outputs entry declaring 'versioned' reads versioned", () => {
    const parsed = PluginManifestSchema.parse(
      withOutputs({ weekly_report: { type: 'string', temporality: 'versioned' } }),
    )
    expect(parsed.outputs['weekly_report']?.temporality).toBe('versioned')
  })

  /**
   * The name is a KEY in `plugin_runs` and `denials`, both plain objects. A
   * plugin called `__proto__` invoked the prototype setter on write: the
   * record was silently dropped, so the plugin was due again on the next
   * advance and re-fired the side effects the record exists to stop. The rest
   * of the prototype answers a lookup with an inherited member rather than the
   * absence that is the truth.
   */
  test('a name that is a member of Object.prototype is refused, naming the field', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      let threw = false
      try {
        PluginManifestSchema.parse({ ...validManifest, name })
      } catch (e) {
        threw = true
        expect((e as z.ZodError).issues[0]?.path).toEqual(['name'])
      }
      expect(threw).toBe(true)
    }

    // `prototype` is NOT a member of Object.prototype, so it reads as absent
    // like any other unused key and is not refused. Non-vacuity for the loop:
    // the refusal is derived from the prototype, not a blocklist of
    // suspicious-looking words.
    expect(PluginManifestSchema.parse({ ...validManifest, name: 'prototype' }).name).toBe('prototype')
  })

  // The load-bearing case. A misdeclared value must stop the plugin at import
  // rather than fall back to the default — a plugin running under a guessed
  // versioning policy is the failure this field exists to prevent.
  test('an unrecognised temporality throws, naming the field, rather than defaulting', () => {
    let threw = false
    try {
      PluginManifestSchema.parse(withOutputs({ report: { type: 'string', temporality: 'append' } }))
    } catch (e) {
      threw = true
      expect(e).toBeInstanceOf(z.ZodError)
      const issue = (e as z.ZodError).issues[0]
      expect(issue?.path).toEqual(['outputs', 'report', 'temporality'])
    }
    expect(threw).toBe(true)
  })
})

/**
 * `inputs.type` and `inputs.default`.
 *
 * The type set is closed for the same reason `outputs.temporality` is: a value
 * outside it fails `.parse()` rather than falling back, and manifests are
 * parsed at import time, so a misspelled type name stops the plugin instead of
 * running unvalidated forever.
 */
describe('inputs.type and inputs.default', () => {
  const withInputs = (inputs: Record<string, unknown>) => ({ ...validManifest, inputs })

  test('a manifest declaring inputs: {} parses and yields {}', () => {
    expect(PluginManifestSchema.parse(withInputs({})).inputs).toEqual({})
  })

  test("declaring 'boolean' parses", () => {
    const parsed = PluginManifestSchema.parse(withInputs({ dry_run: { type: 'boolean' } }))
    expect(parsed.inputs['dry_run']?.type).toBe('boolean')
  })

  test('an unsupported type fails .parse() and the message names the field', () => {
    let threw = false
    try {
      PluginManifestSchema.parse(withInputs({ site_url: { type: 'strng' } }))
    } catch (e) {
      threw = true
      expect((e as z.ZodError).issues[0]?.path).toEqual(['inputs', 'site_url', 'type'])
      expect((e as z.ZodError).message).toContain('site_url')
    }
    expect(threw).toBe(true)
  })

  test('a declared default round-trips through .parse()', () => {
    const parsed = PluginManifestSchema.parse(
      withInputs({ retention_days: { type: 'number', required: false, default: 90 } }),
    )
    expect(parsed.inputs['retention_days']?.default).toBe(90)
  })

  test('an input omitting default reads undefined, so the field stays additive', () => {
    const parsed = PluginManifestSchema.parse(withInputs({ site_url: { type: 'string' } }))
    expect(parsed.inputs['site_url']?.default).toBeUndefined()
    expect(parsed.inputs['site_url']?.required).toBe(true)
  })

  /**
   * `array` and `object` are members.
   *
   * They were left out on the stated premise that nothing declares them. The
   * premise was published and it was false: a consumer's manifest declaring a
   * list-valued input hits `PluginManifestSchema.parse()` at import time, which
   * is a runtime throw no compiler sees, and it fails on a set the document
   * claims is closed because the members are unused.
   *
   * These two cases are what makes that a check rather than a claim.
   */
  test("declaring 'array' parses", () => {
    const parsed = PluginManifestSchema.parse(withInputs({ rows: { type: 'array' } }))
    expect(parsed.inputs['rows']?.type).toBe('array')
  })

  test("declaring 'object' parses", () => {
    const parsed = PluginManifestSchema.parse(withInputs({ payload: { type: 'object' } }))
    expect(parsed.inputs['payload']?.type).toBe('object')
  })

  test('the set stays closed — a sixth name is still a hard parse failure', () => {
    let threw = false
    try {
      PluginManifestSchema.parse(withInputs({ rows: { type: 'list' } }))
    } catch (e) {
      threw = true
      expect((e as z.ZodError).issues[0]?.path).toEqual(['inputs', 'rows', 'type'])
    }
    expect(threw).toBe(true)
  })
})

/**
 * `approval_class` and the cross-field rule it carries.
 *
 * The rule lives on the schema and not in the loader, so every reader — the
 * advance, `plan`, `approve`, `deny` — validates under one rule. A loader-side
 * rule would let a manifest imported by a CLI verb validate more weakly than the
 * advance's, and the review-gate exemption would then apply to a `supervised`
 * plugin the advance would have rejected. These cases are what pins that: they
 * assert `.parse()` itself, which is the thing every reader calls.
 *
 * Each failure is asserted on its PATH and on its message naming a reason. A
 * bare "it threw" is green on a manifest that failed for an unrelated field, and
 * a message that says only "invalid" is not a repair instruction.
 */
const contentBase = {
  ...validManifest,
  approval_class: 'content' as const,
  autonomy_level: 'autonomous' as const,
  side_effects: ['sends_email'] as const,
  dependencies: ['gsc-auth'],
}

/** The issue paths a failed `.parse()` reports, sorted for a stable compare. */
function issuePaths(input: unknown): string[] {
  try {
    PluginManifestSchema.parse(input)
  } catch (e) {
    return (e as z.ZodError).issues.map((i) => i.path.join('.')).sort()
  }
  throw new Error('expected .parse() to throw, and it did not')
}

/** The messages a failed `.parse()` reports, joined so one grep covers them. */
function issueText(input: unknown): string {
  try {
    PluginManifestSchema.parse(input)
  } catch (e) {
    return (e as z.ZodError).issues.map((i) => i.message).join('\n')
  }
  throw new Error('expected .parse() to throw, and it did not')
}

describe('approval_class and its cross-field rule', () => {
  test('a manifest omitting approval_class parses and reads session', () => {
    expect(PluginManifestSchema.parse(validManifest).approval_class).toBe('session')
  })

  test('the content base used by the cases below is itself valid', () => {
    // Non-vacuity. Without this, every refusal below could be firing on
    // something the base got wrong rather than on the field under test.
    expect(PluginManifestSchema.parse(contentBase).approval_class).toBe('content')
  })

  test('an unrecognised approval_class value fails, naming the field', () => {
    expect(issuePaths({ ...validManifest, approval_class: 'batch' })).toEqual(['approval_class'])
  })

  test('content with no declared side effect fails, naming the reason', () => {
    const input = { ...contentBase, side_effects: [] }
    expect(issuePaths(input)).toEqual(['side_effects'])
    expect(issueText(input)).toContain('at least one declared side effect')
  })

  test('content with zero dependencies fails, naming the reason', () => {
    const input = { ...contentBase, dependencies: [] }
    expect(issuePaths(input)).toEqual(['dependencies'])
    expect(issueText(input)).toContain('exactly one declared dependency')
  })

  test('content with two dependencies fails, naming the reason', () => {
    const input = { ...contentBase, dependencies: ['gsc-auth', 'other'] }
    expect(issuePaths(input)).toEqual(['dependencies'])
    expect(issueText(input)).toContain('exactly one declared dependency')
  })

  test('content with a non-autonomous autonomy level fails, naming the reason', () => {
    const input = { ...contentBase, autonomy_level: 'supervised' }
    expect(issuePaths(input)).toEqual(['autonomy_level'])
    expect(issueText(input)).toContain("requires autonomy_level 'autonomous'")
  })

  test('the rule does not fire on a session-class manifest', () => {
    // The partition, as a parse result. A session-class plugin with no
    // dependencies and no side effects is ordinary and must stay ordinary.
    const parsed = PluginManifestSchema.parse({
      ...validManifest,
      side_effects: [],
      dependencies: [],
      autonomy_level: 'supervised',
    })
    expect(parsed.approval_class).toBe('session')
  })
})
