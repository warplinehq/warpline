/**
 * The claude-code renderer: one try is one `claude -p --bare` child, tool-less
 * by default.
 *
 * The context goes in on stdin and never on argv, because argv is visible to
 * every local user. The child env is a literal allowlist, never a copy of the
 * caller's. The child's cwd and HOME are two fresh empty dirs under `/tmp`,
 * removed after the call. Nothing the model prints is executed or resolved as a
 * path: the text goes back to the caller as text.
 *
 * `--bare` never reads a subscription login (OAuth and the keychain are out of
 * its reach), so this renderer needs an API key or a cloud credential in one of
 * the passthrough variables.
 *
 * `selectModelId`, the api-error-first rule and the isolation constants were
 * measured by the bench and are promoted here unchanged; the bench imports them
 * back from this module.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { toMicroUp, type Rendered } from './renderers.js'

/** The terminal reason that means the provider, not the arm. */
export const API_ERROR_REASON = 'api_error'

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * The sandbox every isolated session runs in: on, no host allowed, no escape
 * hatch for an unsandboxed command, and the filesystem left exactly as a public
 * session has it.
 *
 * A tracked constant and not a config value, so no configuration can weaken it
 * and the pre-registration freezes one reviewable literal.
 */
export const ISOLATION_SETTINGS = {
  sandbox: {
    enabled: true,
    filesystem: { disabled: true },
    network: { allowedDomains: [], strictAllowlist: true },
    allowUnsandboxedCommands: false,
  },
} as const

/**
 * The in-process tools an isolated session has removed by bare name. The
 * sandbox covers subprocesses and not these, and a bare name removes the tool
 * from the session outright, which a command-text pattern does not.
 */
export const ISOLATION_REMOVED_TOOLS = ['WebFetch', 'WebSearch', 'RemoteTrigger'] as const

/**
 * Which of the per-model usage keys names the model that did the work.
 *
 * MEASURED, and the reason this is not `keys[0]`: a session that uses a tool
 * reports TWO models, and the auxiliary one is inserted FIRST. A real smoke
 * iteration of all three arms returned `claude-haiku-4-5-20251001` — 912 input
 * tokens for one internal step — ahead of the pinned model that served every
 * turn. Taking the first key would stamp every record in the published set with
 * a model that did none of the work, and the method's own requirement that the
 * id be one string across the whole set would then be checking the auxiliary
 * model rather than the measured one.
 *
 * So the key is SELECTED by matching the requested id, and the KEY is what is
 * returned — the dated canonical form when the tool reports one. This is still
 * a read-back rather than an echo, and it is the stronger version of it: a run
 * the requested model never served returns null, and null is not a publishable
 * record, so a silent model substitution stops the set instead of entering it.
 */
export function selectModelId(modelUsage: unknown, requested: string): string | null {
  for (const [key, entry] of Object.entries(asRecord(modelUsage))) {
    const canonical = asRecord(entry).canonicalModel
    const named = typeof canonical === 'string' ? canonical : ''
    if (key.startsWith(requested) || named.startsWith(requested)) return key
  }
  return null
}

/**
 * The oldest CLI this renderer runs. 2.1.305 is the first release with the
 * model-access fallback switch and the hardened bare mode, and it is past the
 * 2.1.304 regression that failed every gateway request when tools are narrowed.
 */
export const CLAUDE_CLI_FLOOR = '2.1.305'

/** A try that runs past this is killed, and fails with its cost unknown. */
export const CLAUDE_TIMEOUT_MS = 600_000

/** `--version` answers at once; a hung one must not hang the pass. */
const PROBE_TIMEOUT_MS = 30_000

/** The caller's variables a child may see, and only when set: provider credentials, cloud config and proxies. */
export const CLAUDE_ENV_PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_VERTEX',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
] as const

/**
 * The tool-less argv. `--bare` alone still grants Bash and the file tools, so
 * `--tools ''` is what removes them. `--setting-sources ''` drops every settings
 * file, a `fallbackModel` setting included, and no `--fallback-model` is passed.
 */
export function buildToollessArgv(model: string, capMicro: number | null): string[] {
  const argv = [
    '-p',
    '--bare',
    '--tools',
    '',
    '--output-format',
    'json',
    '--model',
    model,
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
  ]
  if (capMicro !== null) argv.push('--max-budget-usd', (capMicro / 1e6).toFixed(6))
  return argv
}

/**
 * The child env, built up from nothing. PATH leads with the binary's own dir so
 * an npm-installed `claude` finds its `node`.
 */
export function buildConsumeEnv(
  parent: Readonly<Record<string, string | undefined>>,
  home: string,
  binDir: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: home,
    TERM: 'dumb',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  for (const name of CLAUDE_ENV_PASSTHROUGH) {
    const value = parent[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** The leading `major.minor.patch` of a `--version` line, or null. */
export function parseCliVersion(text: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Whether a `--version` line names the floor or later. An unparseable line does not. */
export function meetsFloor(text: string): boolean {
  const have = parseCliVersion(text)
  const floor = parseCliVersion(CLAUDE_CLI_FLOOR)!
  if (have === null) return false
  for (let i = 0; i < 3; i++) if (have[i] !== floor[i]) return have[i]! > floor[i]!
  return true
}

/**
 * The first `claude` on `pathVar` that is an executable file, as an absolute
 * path. Relative PATH entries are skipped: they would resolve against the cwd.
 */
export function resolveClaudeBin(pathVar: string | undefined): string | null {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, 'claude')
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Absent or not executable: the next entry.
    }
  }
  return null
}

/**
 * The fields a renderer reads from one result object. The api-error rule runs
 * first and does not read the subtype: an unauthenticated call comes back with
 * `subtype: "success"`, a zero cost and `is_error: true`.
 */
export function readClaudeResult(
  raw: unknown,
  requested: string,
): { apiError: boolean; isError: boolean; text: string | null; totalCostUsd: number | null; served: string | null } {
  const result = asRecord(raw)
  const isError = result.is_error === true
  return {
    apiError: isError && result.terminal_reason === API_ERROR_REASON,
    isError,
    text: typeof result.result === 'string' ? result.result : null,
    totalCostUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    served: selectModelId(result.modelUsage, requested),
  }
}

/** A fresh empty cwd and HOME under `/tmp` for one child, both removed afterwards. */
async function withScratch<T>(fn: (cwd: string, home: string) => Promise<T>): Promise<T> {
  // /tmp, not os.tmpdir(): on darwin that is a 0700 per-user dir another account cannot enter.
  const dirs: string[] = []
  try {
    dirs.push(await mkdtemp(join('/tmp', 'warpline-consume-')))
    dirs.push(await mkdtemp(join('/tmp', 'warpline-consume-')))
    return await fn(dirs[0]!, dirs[1]!)
  } finally {
    for (const d of dirs) await rm(d, { recursive: true, force: true })
  }
}

/**
 * Run one child to its end or its deadline. Past the deadline it is killed and
 * the call settles at once: a grandchild still holding stdout must not hold the
 * caller too.
 */
function runChild(
  bin: string,
  argv: string[],
  o: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number },
): Promise<{ stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const settle = (timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), timedOut })
    }
    const child = spawn(bin, argv, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(true)
    }, o.timeoutMs)
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    // A child that exits without reading stdin breaks the pipe; its stdout still decides.
    child.stdin.on('error', () => {})
    child.on('error', () => settle(false))
    child.on('close', () => settle(false))
    child.stdin.end(o.stdin)
  })
}

/** The CLI's `--version` line, or null when it printed none. */
export async function probeClaudeVersion(
  bin: string,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  return withScratch(async (cwd, home) => {
    const { stdout, timedOut } = await runChild(bin, ['--version'], {
      cwd,
      env: buildConsumeEnv(parentEnv, home, dirname(bin)),
      stdin: '',
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const line = stdout.split('\n')[0]!.trim()
    return timedOut || line === '' ? null : line
  })
}

/** One tool-less try. Stdout is read whatever the exit status. */
export async function renderClaudeCode(o: {
  bin: string
  model: string
  prompt: string
  capMicro: number | null
  parentEnv: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
}): Promise<Rendered> {
  const failed = (reason: string): Rendered => ({
    ok: false,
    text: null,
    served: null,
    cost_micro_usd: null,
    cost_basis: 'unknown',
    reason,
  })
  return withScratch(async (cwd, home) => {
    const { stdout, timedOut } = await runChild(o.bin, buildToollessArgv(o.model, o.capMicro), {
      cwd,
      env: buildConsumeEnv(o.parentEnv, home, dirname(o.bin)),
      stdin: o.prompt,
      timeoutMs: o.timeoutMs ?? CLAUDE_TIMEOUT_MS,
    })
    if (timedOut) return failed('the renderer did not answer in time')
    let raw: unknown
    try {
      raw = JSON.parse(stdout.trim())
    } catch {
      return failed('the renderer printed no result')
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return failed('the renderer printed no result')
    const r = readClaudeResult(raw, o.model)
    const usd = r.totalCostUsd
    const micro = usd !== null && Number.isFinite(usd) && usd >= 0 ? toMicroUp(usd) : null
    const cost = micro !== null && Number.isSafeInteger(micro) ? micro : null
    const priced = { served: r.served, cost_micro_usd: cost, cost_basis: cost === null ? 'unknown' : 'reported' } as const
    if (r.apiError) return { ok: false, text: null, ...priced, reason: 'the provider was not reachable' }
    if (r.isError) return { ok: false, text: null, ...priced, reason: 'the renderer reported an error' }
    if (r.text === null) return { ok: false, text: null, ...priced, reason: 'the renderer printed no result' }
    return { ok: true, text: r.text, ...priced, reason: null }
  })
}
