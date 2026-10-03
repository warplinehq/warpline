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
 * This file is the only guard on the EPIPE listener. bun exits 0 quietly on
 * EPIPE with or without it, so no spawn of bun can see it removed. node, which
 * runs the published bin, prints an unhandled 'error' stack and exits 1
 * without it.
 */
import { describe, it, expect } from 'bun:test'
import { Writable } from 'node:stream'

import { drained } from '../exit-after-flush.js'

/** A stream whose every write fails the way a real pipe's does: asynchronously, with `code`. */
function failingWith(code: string): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      setImmediate(() => cb(Object.assign(new Error(`write ${code}`), { code })))
    },
  })
}

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

  it('settles quietly when a write arrives after the end', async () => {
    const w = new Writable({
      write(_chunk, _enc, cb) {
        cb()
      },
    })
    const p = drained(w)
    w.write('late')
    await p
  })
})
