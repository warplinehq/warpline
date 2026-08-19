import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve a directory relative to a test file: testFixturesDir(import.meta.url, 'fixtures'). */
export function testFixturesDir(testFileMetaUrl: string, ...subPaths: string[]): string {
  const dir = path.dirname(fileURLToPath(testFileMetaUrl))
  return path.resolve(dir, ...subPaths)
}
