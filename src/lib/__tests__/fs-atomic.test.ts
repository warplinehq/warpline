/**
 * fs-atomic tests — Phase 119 Plan 01 Task 1.
 *
 * Covers: atomicWriteJson, atomicWriteText, readJsonOrNull. Pure fs only —
 * no `mock.module` (CLAUDE.md §bun:test gotchas).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { atomicWriteJson, atomicWriteText, readJsonOrNull } from '../fs-atomic.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `fs-atomic-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('atomicWriteJson', () => {
  test('writes to path on success and round-trips via JSON.parse', async () => {
    const path = join(tmpDir, 'foo.json')
    const value = { a: 1, b: ['two', 'three'], nested: { c: true } }
    await atomicWriteJson(path, value)
    const raw = await readFile(path, 'utf-8')
    expect(JSON.parse(raw)).toEqual(value)
  })

  test('creates missing parent directories recursively', async () => {
    const path = join(tmpDir, 'nested', 'deeper', 'file.json')
    await atomicWriteJson(path, { ok: true })
    const raw = await readFile(path, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ ok: true })
  })

  test('no partial file on serialise failure (circular reference)', async () => {
    const path = join(tmpDir, 'circular.json')
    const obj: Record<string, unknown> = { name: 'a' }
    obj.self = obj // circular
    await expect(atomicWriteJson(path, obj)).rejects.toThrow()
    // Target path must not exist.
    await expect(access(path)).rejects.toThrow()
    // No temp-file leak beside target either.
    const entries = await readdir(tmpDir)
    expect(entries.some((e) => e.startsWith('circular.json.tmp-'))).toBe(false)
  })

  test('overwrites existing file atomically', async () => {
    const path = join(tmpDir, 'overwrite.json')
    await atomicWriteJson(path, { v: 1 })
    await atomicWriteJson(path, { v: 2 })
    const raw = await readFile(path, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ v: 2 })
  })
})

describe('readJsonOrNull', () => {
  test('returns null for missing file (ENOENT)', async () => {
    const path = join(tmpDir, 'missing.json')
    const result = await readJsonOrNull<{ any: string }>(path)
    expect(result).toBeNull()
  })

  test('returns parsed JSON for valid file', async () => {
    const path = join(tmpDir, 'valid.json')
    await atomicWriteJson(path, { hello: 'world', n: 42 })
    const result = await readJsonOrNull<{ hello: string, n: number }>(path)
    expect(result).toEqual({ hello: 'world', n: 42 })
  })

  test('rethrows on invalid JSON (not ENOENT)', async () => {
    const path = join(tmpDir, 'invalid.json')
    await atomicWriteText(path, '{not json')
    await expect(readJsonOrNull(path)).rejects.toThrow()
  })
})

describe('atomicWriteText', () => {
  test('writes plain text atomically', async () => {
    const path = join(tmpDir, 'current-email-sig.md')
    const content = '---\nformat: email-sig\n---\nHello signature.'
    await atomicWriteText(path, content)
    const raw = await readFile(path, 'utf-8')
    expect(raw).toBe(content)
  })

  test('creates missing parent directories', async () => {
    const path = join(tmpDir, 'a', 'b', 'c.txt')
    await atomicWriteText(path, 'body')
    expect(await readFile(path, 'utf-8')).toBe('body')
  })
})
