/**
 * `warpline audit` — read the audit store, and pass over a line its walk stops on.
 *
 * `head` prints the last record's seq and the sha256 of its bytes, or `0` and
 * 64 zeros before the first record. Keeping that line somewhere off this box is
 * what a later check of the store is measured against. `head --c2sp` prints the
 * same head as an unsigned C2SP-shaped note body.
 *
 * `export --after <seq>` streams every complete record after that seq, a line
 * at a time, and waits for the reader before it writes more.
 *
 * `verify --checkpoint <file|->` checks the store against an anchor taken
 * earlier, and tells tampering from a torn tail.
 *
 * `pass-over <seq>...` opens a new segment that passes over each named line the
 * walk stops on, and edits none of them.
 *
 * `head`, `export` and `verify` take no lock and write nothing. `pass-over`
 * takes the audit lock and appends one new segment. None of them creates a
 * store on a home that has none.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { open } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { AuditAppendError, c2spNote, parseAnchor, passOver, readCompleteLines, readHead, verifyStore, type Anchor } from '../lib/audit-log.js'
import { engineStatePath } from '../lib/paths.js'

export const USAGE = `Usage: warpline audit head [--c2sp]
       warpline audit export --after <seq>
       warpline audit verify --checkpoint <file|->
       warpline audit pass-over <seq>...

head      Prints the head of the audit record as "<seq> <hash>" on one line: the
          last record's seq and the sha256 of its bytes. Keep it somewhere off
          this box. --c2sp prints it as an unsigned note body instead: the
          home id, the seq and the base64 hash, one per line.
export    Prints every complete record after <seq> as CloudEvents JSON, one per
          line. <seq> is 0 or a positive integer, at most the head.
verify    Checks the record against a head kept off this box, read from <file>
          or from stdin with -. Exits 0 clean, 3 torn, 4 tampered, 5 wrong log,
          6 when the open intents cannot be read.
pass-over Opens a new segment that passes over each named line of the active
          segment the walk stops on. It edits none of them, and names each by
          seq and sha256, which verify checks.
`

export const VERIFY_CLEAN = 0
export const VERIFY_TORN = 3
export const VERIFY_TAMPERED = 4
export const VERIFY_WRONG_LOG = 5
export const VERIFY_UNREADABLE = 6

/** The longest anchor read, from a file or stdin. */
const ANCHOR_MAX_BYTES = 65_536

function usage(sub: string, err: unknown): number {
  process.stderr.write(`warpline audit ${sub}: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
  return 1
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'head':
      return head(rest)
    case 'export':
      return exportAfter(rest)
    case 'verify':
      return verify(rest)
    case 'pass-over':
      return passOverLines(rest)
    default:
      process.stderr.write(USAGE)
      return 1
  }
}

async function head(args: string[]): Promise<number> {
  let c2sp: boolean
  try {
    const { values } = parseArgs({ args, options: { c2sp: { type: 'boolean' } }, allowPositionals: false, strict: true })
    c2sp = values.c2sp === true
  } catch (err) {
    return usage('head', err)
  }
  let h: { seq: number; head: string }
  try {
    h = await readHead(engineStatePath())
  } catch (err) {
    if ((err as Error).name !== 'AuditHeadUnreadableError') throw err
    process.stderr.write(
      'audit head: the active segment holds no readable last line, so there is no head to print. warpline audit verify names the line, and warpline audit pass-over <seq> goes past a last line that is not a record.\n',
    )
    return 1
  }
  if (!c2sp) {
    process.stdout.write(`${h.seq} ${h.head}\n`)
    return 0
  }
  if (h.seq === 0) {
    process.stderr.write('audit head --c2sp: the store has no records yet, so there is no origin to name.\n')
    return 1
  }
  process.stdout.write(await c2spNote(engineStatePath()))
  return 0
}

async function exportAfter(args: string[]): Promise<number> {
  let after: number
  try {
    const { values } = parseArgs({ args, options: { after: { type: 'string' } }, allowPositionals: false, strict: true })
    if (values.after === undefined) throw new Error('--after <seq> is required')
    if (!/^(0|[1-9][0-9]*)$/.test(values.after) || !Number.isSafeInteger(Number(values.after))) {
      throw new Error('--after takes 0 or a positive integer')
    }
    after = Number(values.after)
  } catch (err) {
    return usage('export', err)
  }
  // With no readable head there is nothing to hold --after against, and every
  // complete line is streamed: an export must be possible to keep before a pass-over.
  let seq: number | null = null
  try {
    seq = (await readHead(engineStatePath())).seq
  } catch (err) {
    if ((err as Error).name !== 'AuditHeadUnreadableError') throw err
  }
  if (seq !== null && after > seq) {
    process.stderr.write(`audit export: --after ${after} is beyond head ${seq}.\n`)
    return 1
  }

  // A reader that has gone away never drains, so a wait for 'drain' alone
  // would never end. Each wait races 'drain' against 'close' and the error.
  const out = process.stdout
  let failed: Error | null = null
  let closed = false
  let wake: () => void = () => {}
  const onError = (err: Error): void => {
    failed = err
    wake()
  }
  const onClose = (): void => {
    closed = true
    wake()
  }
  out.on('error', onError)
  out.on('close', onClose)
  try {
    for await (const { line } of readCompleteLines(engineStatePath(), after)) {
      if (failed !== null || closed) break
      if (out.write(line)) continue
      await new Promise<void>((resolve) => {
        wake = resolve
        out.once('drain', resolve)
        if (failed !== null || closed) resolve()
      })
      out.removeListener('drain', wake)
      if (failed !== null || closed) break
    }
  } finally {
    out.removeListener('error', onError)
    out.removeListener('close', onClose)
  }
  // A reader that went away ends this quietly: the bin's drain keeps it so.
  return 0
}

/** The anchor's text from a file or stdin, refused past 64 KiB. */
async function readAnchor(from: string): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  const take = (chunk: Buffer): void => {
    size += chunk.length
    if (size > ANCHOR_MAX_BYTES) throw new Error('the anchor is over 64 KiB')
    chunks.push(chunk)
  }
  if (from === '-') {
    for await (const chunk of process.stdin) take(Buffer.from(chunk as Uint8Array))
  } else {
    let fh
    try {
      fh = await open(from, 'r')
    } catch {
      throw new Error('the anchor file could not be read')
    }
    try {
      const buf = Buffer.alloc(ANCHOR_MAX_BYTES + 1)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      take(buf.subarray(0, bytesRead))
    } finally {
      await fh.close()
    }
  }
  return Buffer.concat(chunks).toString('utf-8')
}

const CODES = {
  clean: VERIFY_CLEAN,
  torn: VERIFY_TORN,
  tampered: VERIFY_TAMPERED,
  unreadable: VERIFY_UNREADABLE,
  wrong_log: VERIFY_WRONG_LOG,
}

async function verify(args: string[]): Promise<number> {
  let anchor: Anchor
  try {
    const { values } = parseArgs({
      args,
      options: { checkpoint: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    })
    if (values.checkpoint === undefined) throw new Error('--checkpoint <file|-> is required: there is no unanchored check')
    anchor = parseAnchor(await readAnchor(values.checkpoint))
  } catch (err) {
    return usage('verify', err)
  }

  const v = await verifyStore(engineStatePath(), anchor, Date.now())
  const lines = [`verdict: ${v.verdict === 'wrong_log' ? 'wrong log' : v.verdict}`, `anchor: ${anchor.seq} ${anchor.hex}`]
  if (v.head !== null) lines.push(`head: ${v.head.seq} ${v.head.hex}`)
  if (v.stale !== null) {
    lines.push(
      v.stale.seconds === null
        ? `stale: ${v.stale.records} records`
        : `stale: ${v.stale.records} records, ${v.stale.seconds} s since ${v.stale.anchored_at}`,
    )
  }
  if (v.reason !== null) lines.push(`reason: ${v.reason}`)
  // Under any verdict. A walk that stopped is never printed as no open intents.
  if (v.open_intents === null) lines.push(`open intents unreadable: ${v.intents_unreadable}`)
  else for (const i of v.open_intents) lines.push(`open intent: seq ${i.seq} plugin ${i.plugin} run ${i.run_id}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return CODES[v.verdict]
}

async function passOverLines(args: string[]): Promise<number> {
  let seqs: number[]
  try {
    const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true })
    if (positionals.length === 0) throw new Error('name at least one <seq>')
    for (const p of positionals) {
      if (!/^[1-9][0-9]*$/.test(p) || !Number.isSafeInteger(Number(p))) throw new Error('each <seq> is a positive integer')
    }
    seqs = positionals.map(Number)
  } catch (err) {
    return usage('pass-over', err)
  }
  try {
    const { opened, passed } = await passOver(engineStatePath(), seqs)
    process.stdout.write(
      `Passed over seq ${passed.join(', ')} in a new segment that opens at seq ${opened}. No line was edited. Keep the new head off this box: warpline audit head\n`,
    )
    return 0
  } catch (err) {
    if (!(err instanceof AuditAppendError)) throw err
    process.stderr.write(`audit pass-over: ${err.reason}. Nothing was written.\n`)
    return 1
  }
}
