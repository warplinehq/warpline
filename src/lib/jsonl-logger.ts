/**
 * JSONL run logger for headless Warpline runs.
 *
 * Appends structured JSON lines to {logsDir}/runs/{YYYY-MM-DD}.jsonl.
 * Each line is a RunJsonlEvent with ts, run_id, level, and event fields.
 * Supports pruning files older than N days (default 30).
 *
 * Implements D-10 (JSONL logging), D-11 (file naming), D-12 (event schema), D-13 (30-day prune).
 */
import { mkdir, appendFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface RunJsonlEvent {
  ts: string              // ISO timestamp
  run_id: string          // shared across all events in a single run
  level: 'info' | 'warn' | 'error'
  event: string           // e.g. 'run_start', 'plugin_start', 'plugin_result', 'self_heal', 'run_end', 'error'
  plugin?: string
  status?: string
  elapsed_ms?: number
  detail?: string
}

export class JsonlRunLogger {
  public readonly run_id: string
  private readonly runsDir: string  // {logsDir}/runs/
  private readonly filePath: string

  constructor(opts: { logsDir: string; runId?: string; run_id?: string }) {
    // Accept either runId (test API) or run_id (internal API)
    this.run_id = opts.runId ?? opts.run_id ?? randomUUID()
    this.runsDir = join(opts.logsDir, 'runs')
    const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    this.filePath = join(this.runsDir, `${date}.jsonl`)
  }

  async appendEvent(ev: Omit<RunJsonlEvent, 'ts' | 'run_id'>): Promise<void> {
    await mkdir(this.runsDir, { recursive: true })
    const full: RunJsonlEvent = {
      ts: new Date().toISOString(),
      run_id: this.run_id,
      ...ev,
    }
    await appendFile(this.filePath, JSON.stringify(full) + '\n', 'utf-8')
  }

  async prune(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000
    const entries = await readdir(this.runsDir).catch(() => [] as string[])
    let removed = 0
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(this.runsDir, f)
      const s = await stat(p).catch(() => null)
      if (s && s.mtimeMs < cutoff) {
        await unlink(p).catch(() => {})
        removed++
      }
    }
    return removed
  }
}
