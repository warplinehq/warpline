/**
 * exit-after-flush tests.
 *
 * Covers: drained, the error policy of the drain that runs before every exit.
 * Pure unit — each case ends a fake `Writable`, never the real stdout or
 * stderr, and nothing here calls the exit helper. Ending a real stream can't
 * be undone, and about 60 test stubs of `process.stdout.write` never call
 * their callback, so a drain of the real stream from inside the suite would
 * either wait forever or silence every file after this one.
 *
 * The drain drops a write that arrives after it began, so the queue flushes in
 * full, and a late write that reaches the stream anyway still settles it
 * quietly rather than hanging or crashing.
 *
 * This file pins the drain's error policy in-process. Where the guard is
 * placed on the real streams, which only node can see, is pinned by
 * src/cli/__tests__/closed-reader.test.ts.
 */
import { describe, it, expect } from 'bun:test'
import { Writable } from 'node:stream'

import { drained, guardStream } from '../exit-after-flush.js'

/** A stream whose every write fails the way a real pipe's does: asynchronously, with `code`. */
function failingWith(code: string): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      setImmediate(() => cb(Object.assign(new Error(`write ${code}`), { code })))
    },
  })
}

/** One turn of the event loop, so a failing write's error has been raised. */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('drained', () => {
  it('settles quietly when the reader has gone away (EPIPE)', async () => {
    const w = failingWith('EPIPE')
    w.write('document')
    await drained(w)
  })

  it('rejects on any other write error (EIO)', async () => {
    const w = failingWith('EIO')
    w.write('document')
    await expect(drained(w)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('a write after the drain began is dropped, and what was queued before it still flushes', async () => {
    const written: string[] = []
    // Each chunk lands 5 ms after it is handed over, so `b` and `c` are still
    // buffered when the late write arrives.
    const w = new Writable({
      write(chunk, _enc, cb) {
        setTimeout(() => {
          written.push(String(chunk))
          cb()
        }, 5)
      },
    })
    w.write('a')
    w.write('b')
    w.write('c')
    const p = drained(w)
    let lateDone = false
    w.write('late', () => {
      lateDone = true
    })
    await p
    expect(written).toEqual(['a', 'b', 'c'])
    await tick()
    expect(lateDone).toBe(true)
  })

  it('a late write that reaches the stream anyway still settles quietly', async () => {
    const w = new Writable({
      write(_chunk, _enc, cb) {
        cb()
      },
    })
    const p = drained(w)
    // Around anything the drain put on the instance, straight to the stream.
    Writable.prototype.write.call(w, 'late', 'utf8')
    await p
  })

  it('a second drain of the same stream settles with the first', async () => {
    const w = new Writable({
      write(_chunk, _enc, cb) {
        cb()
      },
    })
    w.write('document')
    await drained(w)
    await drained(w)
  })

  it('a reader that went away before the drain leaves it quiet', async () => {
    const w = failingWith('EPIPE')
    guardStream(w)
    w.write('document')
    await tick()
    await tick()
    await drained(w)
  })

  it('any other write error before the drain still fails it (EIO)', async () => {
    const w = failingWith('EIO')
    guardStream(w)
    w.write('document')
    await tick()
    await tick()
    await expect(drained(w)).rejects.toMatchObject({ code: 'EIO' })
  })
})
