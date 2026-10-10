/**
 * `withHome` scopes the home to one async call tree.
 *
 * Inside the scope it beats `_setHome` and `WARPLINE_HOME`, a nested scope
 * beats its parent, and leaving a scope restores whatever resolved before it.
 * The store lives on `globalThis`, so the published `warpline/lib/paths` copy
 * under dist/, which example handlers import, sees the same scope as src/.
 *
 * No case writes: these resolve paths and nothing creates them.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _setHome, warplineHome, withHome } from '../paths.js'
import { warplineHome as publishedHome } from 'warpline/lib/paths'

const A = join(tmpdir(), 'warpline-paths-scope-a')
const B = join(tmpdir(), 'warpline-paths-scope-b')
const SET = join(tmpdir(), 'warpline-paths-set-home')

afterEach(() => _setHome(null))

describe('withHome', () => {
  test('the scope beats WARPLINE_HOME', async () => {
    const env = process.env.WARPLINE_HOME
    expect(env).toBeDefined()
    expect(warplineHome()).toBe(resolve(env as string))
    expect(await withHome(A, async () => warplineHome())).toBe(A)
    expect(warplineHome()).toBe(resolve(env as string))
  })

  test('the scope beats _setHome, and leaving it restores _setHome', async () => {
    _setHome(SET)
    expect(await withHome(A, async () => warplineHome())).toBe(A)
    expect(warplineHome()).toBe(SET)
  })

  test('a nested scope beats its parent, and leaving it restores the parent', async () => {
    const seen = await withHome(A, async () => {
      const inner = await withHome(B, async () => {
        await Promise.resolve()
        return warplineHome()
      })
      return [inner, warplineHome()]
    })
    expect(seen).toEqual([B, A])
  })

  test('the scope survives an await, and two concurrent scopes stay apart', async () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
    const [a, b] = await Promise.all([
      withHome(A, async () => {
        await tick()
        return warplineHome()
      }),
      withHome(B, async () => {
        await tick()
        return warplineHome()
      }),
    ])
    expect([a, b]).toEqual([A, B])
  })

  test('the published copy under dist/ sees the same scope', async () => {
    expect(await withHome(A, async () => publishedHome())).toBe(A)
  })

  test('a relative home resolves against cwd', async () => {
    expect(await withHome('rel-home', async () => warplineHome())).toBe(resolve('rel-home'))
  })
})
