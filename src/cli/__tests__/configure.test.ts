/**
 * `warpline configure` and the line-reader seam under it — in-process tests.
 *
 * The reader is driven by INJECTED streams, never by a spawned process with
 * answers piped to it. Piping is the path the research measured as unreliable
 * for the naive primitive, and a test that fed answers slowly would pass with
 * that primitive too. The fast-pipe case below is the one that discriminates.
 */
import { describe, test, expect } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import { isInteractive, lineReader } from '../prompt.js'

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** A writable that keeps everything written to it. */
class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.text += chunk.toString()
    cb()
  }
}

/** Every line in ONE chunk: what a fast pipe delivers. */
function fastPipe(lines: string[]): Readable {
  return Readable.from([lines.map((l) => `${l}\n`).join('')])
}

/** One line per chunk with a pause between: what a human, or a slow pipe, delivers. */
function slowFeed(lines: string[], gapMs = 5): Readable {
  return Readable.from(
    (async function* () {
      for (const l of lines) {
        yield `${l}\n`
        await new Promise((r) => setTimeout(r, gapMs))
      }
    })(),
  )
}

const HUNG = '<hung>'

/**
 * A hang is the failure mode under test, so every ask races a deadline and a
 * hang lands as the sentinel in the collected array — an assertion failure
 * that names what happened, rather than a suite timeout that does not.
 */
async function askAll(input: Readable, output: Writable, prompts: string[]): Promise<unknown[]> {
  const reader = lineReader(input, output)
  const got: unknown[] = []
  try {
    for (const p of prompts) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<string>((r) => {
        timer = setTimeout(() => r(HUNG), 2000)
      })
      const answer = reader.ask(p).catch((err: unknown) => `threw: ${err instanceof Error ? err.name : String(err)}`)
      got.push(await Promise.race([answer, deadline]))
      clearTimeout(timer)
    }
  } finally {
    reader.close()
  }
  return got
}

// ---------------------------------------------------------------------------
// lineReader
// ---------------------------------------------------------------------------

describe('lineReader', () => {
  test('fast pipe: three questions over two lines delivered in ONE chunk return both values then null, with no hang', async () => {
    const out = new Sink()
    const got = await askAll(fastPipe(['alpha', 'beta']), out, ['q1? ', 'q2? ', 'q3? '])
    expect(got).toEqual(['alpha', 'beta', null])
  })

  test('slow feed: the same three questions return the same result', async () => {
    const out = new Sink()
    const got = await askAll(slowFeed(['alpha', 'beta']), out, ['q1? ', 'q2? ', 'q3? '])
    expect(got).toEqual(['alpha', 'beta', null])
  })

  test('EOF: asking past the end returns null rather than hanging, and keeps returning null', async () => {
    const out = new Sink()
    const got = await askAll(Readable.from([]), out, ['q1? ', 'q2? '])
    expect(got).toEqual([null, null])
  })

  test('empty answer: a blank line returns the empty string, which is distinct from null', async () => {
    const out = new Sink()
    const got = await askAll(fastPipe(['']), out, ['q1? ', 'q2? '])
    expect(got).toEqual(['', null])
  })

  test('encoding: a non-ASCII, non-normalised line comes back byte for byte', async () => {
    // `e` + COMBINING ACUTE ACCENT stays decomposed; NFC would fold it to U+00E9.
    const line = 'café é 日本 \u{1f4a1}'
    const out = new Sink()
    const got = await askAll(Readable.from([Buffer.from(`${line}\n`, 'utf8')]), out, ['q? '])
    expect(got).toEqual([line])
    expect(Buffer.from(got[0] as string, 'utf8').equals(Buffer.from(line, 'utf8'))).toBe(true)
  })

  test('output: the prompt text is written to the injected output stream', async () => {
    const out = new Sink()
    await askAll(fastPipe(['a', 'b']), out, ['first> ', 'second> ', 'third> '])
    expect(out.text).toBe('first> second> third> ')
  })
})

describe('isInteractive', () => {
  test('a piped stdin reports isTTY as undefined, and that is not interactive', () => {
    expect(isInteractive({ isTTY: undefined })).toBe(false)
    expect(isInteractive({})).toBe(false)
    expect(isInteractive({ isTTY: false })).toBe(false)
    expect(isInteractive({ isTTY: true })).toBe(true)
  })
})
