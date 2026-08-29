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
