/**
 * A scripted local `/chat/completions` endpoint for the length of `fn`.
 *
 * No test reaches a real provider: a call spends money, needs a credential and
 * sends the prompt off the machine. The stub listens on 127.0.0.1 on a free
 * port. Each call to `/chat/completions` is counted, its JSON body and its
 * `authorization` header are kept, and the n-th scripted reply is returned
 * (the last one repeats past the end). Any other path gets a 404 and is not
 * counted. `beforeReply(n)` is awaited before the n-th reply, so a test can act
 * between the call and the reply. `delayMs` holds every reply that long. The
 * server is stopped in a `finally`.
 */
export type StubReply = { status: number; body?: unknown; headers?: Record<string, string> }

export type OpenAiStub = {
  /** The endpoint to configure: no trailing slash, no path. */
  url: string
  calls: () => number
  bodies: () => unknown[]
  auth: () => Array<string | null>
}

export async function withOpenAiStub<T>(
  script: StubReply[],
  fn: (stub: OpenAiStub) => Promise<T>,
  opts: { beforeReply?: (n: number) => Promise<void>; delayMs?: number } = {},
): Promise<T> {
  if (script.length === 0) throw new Error('withOpenAiStub needs at least one scripted reply')
  const bodies: unknown[] = []
  const auth: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname !== '/chat/completions') return new Response('not found', { status: 404 })
      const text = await req.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
      bodies.push(parsed)
      auth.push(req.headers.get('authorization'))
      const n = bodies.length
      await opts.beforeReply?.(n)
      if (opts.delayMs !== undefined) await Bun.sleep(opts.delayMs)
      const reply = script[Math.min(n, script.length) - 1]!
      const payload = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      return new Response(payload, {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      })
    },
  })
  try {
    return await fn({
      url: `http://127.0.0.1:${server.port}`,
      calls: () => bodies.length,
      bodies: () => [...bodies],
      auth: () => [...auth],
    })
  } finally {
    await server.stop(true)
  }
}
