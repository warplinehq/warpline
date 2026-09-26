/**
 * Every writer of a `plugin_runs` entry records the run that wrote it.
 *
 * **Why the field matters.** An entry's `run_id` is half of the Run-to-Output
 * relationship the content gate reads. Beside `last_output.run_id` it says
 * whether the Output is this run's or one carried from an earlier run, and a
 * content-class consumer never ships a carried Output. A writer that skips the
 * stamp does not fail loudly. It makes the entry read carried, or current,
 * silently, and the gate then decides on a lie.
 *
 * **The behavioural cases drive four of the five writers for real**: the
 * autonomous arm, the arm an invocation that threw takes, the gated arm, and
 * the gate apply. The fifth, the end-of-run merge, is what persisted every
 * entry they read, so it is under test in every one of them.
 *
 * **The census is allowlist-shaped on purpose.** A denylist of known write
 * shapes is the failure this project keeps recording: the guard runs green and
 * the thing it catches is outside its reach. A writer using `Object.assign`, a
 * spread, an alias or a new function would slip past one. So every mutation of
 * a runs map anywhere in `src/`, in every form it can take, must match a row of
 * `RECOGNISED`. A new writer is red until someone adds its row on purpose, and
 * a row that no longer matches is red too. The two planted controls prove each
 * form is reported and that the recognised writers are not.
 *
 * **Each routed row names the run it stamps.** An entry's `run_id` changes
 * only when a run writes its own result, so no write moves it back to an
 * earlier run's. `stamp` is the exact third argument the row's `lastOutputOf`
 * call passes, and a routed write stamping anything else is reported. A row
 * whose stamp is outside `OWN_RUN_STAMPS` is a writer that records a run other
 * than the one writing. The census reads that off the stamp, so there is no
 * flag to leave off, and every such row must have a driver in
 * `SUPERSEDED_BY_A_LATER_RUN` proving it refuses an entry a later run wrote.
 * Today that is the gate apply, which stamps the run that parked the gate.
 *
 * **Syntactic, no type checker**, the `no-approval-gate-from-content.test.ts`
 * precedent. A runs map is recognised by what the source says: any
 * `<x>.plugin_runs` or `<x>['plugin_runs']`, and any name bound to one inside
 * the function that binds it, so `disk` is a runs map inside `mergePluginRuns`
 * and a whole state document elsewhere. The helper takes its source texts
 * rather than reading them, so the identical code runs against the real tree
 * and against in-memory fixtures.
 *
 * **The limit that follows for the stamp.** It is compared as source text, not
 * as the value it is bound to. A name that reads as the writer's own run but
 * holds another passes as own: a local such as `const run_id = prior.run_id`,
 * or a parameter named `runId` that a caller fills with a parked run. Today's
 * writers are each driven by a behavioural case that compares the stamp with
 * the run that ran, which catches it for them. A new writer's binding is
 * outside the census's reach.
 *
 * **Every enumeration throws rather than returning empty.** An empty scan is
 * "did not look", and it would report clean.
 *
 * Writes only into temp homes. The census reads source files and writes
 * nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as ts from 'typescript'
import { runAdvance, type AdvanceOptions, type AdvanceResult } from '../engine.js'
import type { EngineState } from '../../schemas/engine-state.js'
import { _setHome } from '../../lib/paths.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

// ── The behavioural half ────────────────────────────────────────────────────

const PLUGIN = 'prod'

let home: TestHome | undefined

async function setup(preferences?: Record<string, unknown>): Promise<TestHome> {
  home = await createTestHome(preferences === undefined ? undefined : { preferences })
  _setHome(home.root)
  const dir = join(home.pluginsDir, PLUGIN)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      name: PLUGIN,
      version: '1.0.0',
      description: 'producer',
      inputs: {},
      outputs: { brief: { type: 'json' } },
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: [],
      approval_class: 'session',
      // A day, so a parked gate is inside its ceiling when it is applied.
      ttl_hours: 24,
      dependencies: [],
      timeout_ms: 5000,
      max_retries: 0,
      retry_delay_ms: 10,
      max_parallelism: 1,
      min_tier: 'suspended',
    })}`,
  )
  await writeFile(
    join(dir, 'handler.ts'),
    `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['run'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'produced',
    artifacts_produced: [{ type: 'brief', format: 'json', body: '{"n":1}' }],
    schema_version: 1,
  }
}
`,
  )
  return home
}

afterEach(async () => {
  _setHome(null)
  await home?.cleanup()
  home = undefined
})

async function advance(h: TestHome, opts: Partial<AdvanceOptions> = {}): Promise<AdvanceResult> {
  return runAdvance({
    pluginsDir: h.pluginsDir,
    stateDir: join(h.stateDir, 'engine-state.json'),
    runsDir: h.runsDir,
    eventsPath: join(h.runsDir, 'events.jsonl'),
    approvalPath: join(h.root, '.session-approval'),
    preferencesPath: join(h.stateDir, 'preferences.json'),
    ...opts,
  })
}

async function persisted(h: TestHome): Promise<Record<string, unknown> & { last_output?: { run_id?: string } }> {
  const state = JSON.parse(await readFile(join(h.stateDir, 'engine-state.json'), 'utf-8')) as EngineState
  const entry = state.plugin_runs[PLUGIN]
  if (entry === undefined) throw new Error(`no plugin_runs entry for ${PLUGIN}`)
  return entry as Record<string, unknown> & { last_output?: { run_id?: string } }
}

/** `warpline approve` in-process, both streams captured into the result. */
async function approve(argv: string[]): Promise<{ code: number; output: string }> {
  const { run } = await import('../../cli/approve.js')
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  let output = ''
  const sink = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
    return true
  }) as typeof process.stdout.write
  process.stdout.write = sink
  process.stderr.write = sink
  try {
    return { code: await run(argv), output }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

// ── The census ──────────────────────────────────────────────────────────────

type Form = 'assign' | 'delete' | 'builtin' | 'method' | 'escape' | 'spread' | 'key' | 'alias' | 'entry'

/**
 * `routed`: the value is an object literal that spreads a call to
 * `lastOutputOf` and has no `run_id` or `last_output` property of its own
 * anywhere inside it. `erasure`: an object literal whose first element spreads
 * the existing entry and that names no `run_id` anywhere inside it.
 */
type Shape = 'routed' | 'erasure'

interface Recognised {
  readonly file: string
  readonly site: string
  readonly form: Form
  readonly count: number
  readonly shape?: Shape
  /**
   * For a `routed` row, the exact source text of the third argument every
   * `lastOutputOf(…)` call spread at that site passes: the run the write
   * stamps. A routed row that names none is refused as "did not look".
   */
  readonly stamp?: string
}

/**
 * Every mutation of a runs map `src/` is allowed to make. A new writer is red
 * until its row is added here on purpose.
 */
const RECOGNISED: readonly Recognised[] = [
  // The thrown, gated and autonomous arms.
  { file: 'src/runtime/engine.ts', site: 'runAdvance', form: 'assign', count: 3, shape: 'routed', stamp: 'run_id' },
  // The end-of-run document's `plugin_runs: mergePluginRuns(…)`.
  { file: 'src/runtime/engine.ts', site: 'runAdvance', form: 'key', count: 1 },
  // The one writer that stamps a run other than its own: the run that parked
  // the gate.
  {
    file: 'src/runtime/engine.ts',
    site: 'applyPendingGate',
    form: 'assign',
    count: 1,
    shape: 'routed',
    stamp: 'gate.run_id',
  },
  // The refused apply's removal, which makes the plugin due again.
  { file: 'src/runtime/engine.ts', site: 'applyPendingGate', form: 'delete', count: 1 },
  { file: 'src/runtime/engine.ts', site: 'mergePluginRuns', form: 'assign', count: 1, shape: 'routed', stamp: 'runId' },
  // The fresh-read floor `{ ...disk }`, and the typed local it initialises.
  { file: 'src/runtime/engine.ts', site: 'mergePluginRuns', form: 'spread', count: 1 },
  { file: 'src/runtime/engine.ts', site: 'mergePluginRuns', form: 'alias', count: 1 },
  // Erasure rewrites the Output and leaves the entry's run where it was.
  { file: 'src/runtime/engine.ts', site: 'eraseIfReleased', form: 'assign', count: 1, shape: 'erasure' },
  // The schema's own field.
  { file: 'src/schemas/engine-state.ts', site: 'EngineStateSchema', form: 'key', count: 1 },
]

const RUNS_TYPE = "EngineState['plugin_runs']"
const OUTPUT_FIELDS = new Set(['run_id', 'last_output'])
const BUILTINS = new Set([
  'Object.assign',
  'Object.defineProperty',
  'Object.defineProperties',
  'Object.setPrototypeOf',
  'Reflect.set',
  'Reflect.deleteProperty',
  'Reflect.defineProperty',
  'Reflect.setPrototypeOf',
])
/** Callees that read a runs map and never keep or change it. */
const READERS = new Set([
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.hasOwn',
  'structuredClone',
  'JSON.stringify',
])

/** How a name is bound in the scope that declares it. */
type Binding = 'runs' | 'aliased' | 'entry' | 'other'

const isRunsType = (sf: ts.SourceFile, t: ts.TypeNode | undefined): boolean =>
  t !== undefined && t.getText(sf).replace(/\s+/g, '').replaceAll('"', "'") === RUNS_TYPE

const isFunctionLike = (n: ts.Node): n is ts.SignatureDeclaration & { parameters: ts.NodeArray<ts.ParameterDeclaration> } =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n)

const opensScope = (n: ts.Node): boolean =>
  ts.isSourceFile(n) ||
  ts.isBlock(n) ||
  ts.isModuleBlock(n) ||
  isFunctionLike(n) ||
  ts.isForStatement(n) ||
  ts.isForOfStatement(n) ||
  ts.isForInStatement(n) ||
  ts.isCatchClause(n) ||
  ts.isCaseBlock(n)

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isSatisfiesExpression(e)
    ) {
      e = e.expression
    } else {
      return e
    }
  }
}

/** Every expression `e` can evaluate to, through `?:`, `??`, `||` and `&&`. */
function branches(e: ts.Expression): ts.Expression[] {
  const u = unwrap(e)
  if (ts.isConditionalExpression(u)) return [...branches(u.whenTrue), ...branches(u.whenFalse)]
  if (ts.isBinaryExpression(u)) {
    const op = u.operatorToken.kind
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return [...branches(u.left), ...branches(u.right)]
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return branches(u.right)
  }
  return [u]
}

const isAssignmentOp = (k: ts.SyntaxKind): boolean =>
  k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment

const propertyNameText = (n: ts.PropertyName | undefined): string | undefined =>
  n === undefined
    ? undefined
    : ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
      ? n.text
      : undefined

/** `Object.assign`, `JSON.stringify`, `stash`: the callee as dotted text, when it is one. */
function calleeText(e: ts.Expression): string | undefined {
  const u = unwrap(e)
  if (ts.isIdentifier(u)) return u.text
  if (ts.isPropertyAccessExpression(u) && ts.isIdentifier(u.expression)) return `${u.expression.text}.${u.name.text}`
  return undefined
}

/** Whether the literal, or anything nested in it, has a property of one of these names. */
function namesAny(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false
  const walk = (n: ts.Node): void => {
    if (found) return
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && names.has(propertyNameText(n.name) ?? '')) {
      found = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return found
}

interface Mutation {
  readonly file: string
  readonly site: string
  readonly form: Form
  readonly line: number
  /** The assigned value, for an `assign`. */
  readonly value?: ts.Expression
  readonly why: string
}

/**
 * Every mutation of a runs map in `sources` that no row of `allowlist`
 * accepts, every accepted one whose shape fails, and every row whose count the
 * scan does not meet exactly, one string each, naming form, file, line and
 * site.
 */
function runsMapWriteOffenders(
  sources: ReadonlyMap<string, string>,
  allowlist: readonly Recognised[],
): string[] {
  if (sources.size === 0) throw new Error('blind: the source enumeration is empty')
  if (!sources.has('src/runtime/engine.ts')) {
    throw new Error('blind: the source enumeration lacks src/runtime/engine.ts, where every writer lives')
  }
  // An unstated stamp is "did not look": the write would be accepted whatever
  // run it records.
  for (const row of allowlist) {
    if (row.shape === 'routed' && row.stamp === undefined) {
      throw new Error(`blind: routed row ${row.site} names no stamp`)
    }
  }

  const parsed = [...sources].map(([file, text]) => ({
    file,
    sf: ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true),
  }))

  // Every function declared in the scanned sources whose parameter at some
  // position is annotated as a runs map. A runs map passed there is not an
  // escape: the scan covers that function's body under the parameter's name.
  const typedParams = new Map<string, Set<number>>()
  for (const { sf } of parsed) {
    const collect = (n: ts.Node): void => {
      let name: string | undefined
      let fn: (ts.Node & { parameters: ts.NodeArray<ts.ParameterDeclaration> }) | undefined
      if (ts.isFunctionDeclaration(n) && n.name !== undefined) {
        name = n.name.text
        fn = n
      } else if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer !== undefined &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        name = n.name.text
        fn = n.initializer
      }
      if (name !== undefined && fn !== undefined) {
        fn.parameters.forEach((p, i) => {
          if (!isRunsType(sf, p.type)) return
          const at = typedParams.get(name!) ?? new Set<number>()
          at.add(i)
          typedParams.set(name!, at)
        })
      }
      ts.forEachChild(n, collect)
    }
    collect(sf)
  }
  if (typedParams.size === 0) {
    throw new Error('blind: no function in the sources takes a typed runs map, so escapes cannot be told from passes')
  }

  const mutations: Mutation[] = []

  for (const { file, sf } of parsed) {
    const scopes: Map<string, Binding>[] = []
    const consumed = new Set<ts.Node>()

    const lookup = (name: string): Binding => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const b = scopes[i]!.get(name)
        if (b !== undefined) return b
      }
      return 'other'
    }
    const bind = (name: string, b: Binding): void => {
      scopes[scopes.length - 1]!.set(name, b)
    }

    const isRunsAtom = (x: ts.Expression): boolean =>
      (ts.isPropertyAccessExpression(x) && x.name.text === 'plugin_runs') ||
      (ts.isElementAccessExpression(x) &&
        (ts.isStringLiteral(x.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(x.argumentExpression)) &&
        x.argumentExpression.text === 'plugin_runs') ||
      (ts.isIdentifier(x) && (lookup(x.text) === 'runs' || lookup(x.text) === 'aliased'))
    const isRuns = (e: ts.Expression): boolean => branches(e).some(isRunsAtom)
    const isEntry = (e: ts.Expression): boolean =>
      branches(e).some(
        (x) =>
          (ts.isElementAccessExpression(x) && !isRunsAtom(x) && isRuns(x.expression)) ||
          (ts.isIdentifier(x) && lookup(x.text) === 'entry'),
      )
    // A use through an untyped alias is folded into the alias's own report:
    // the binding is the offence, and it is reported once.
    const throughAlias = (e: ts.Expression): boolean =>
      branches(e).some(
        (x) =>
          (ts.isIdentifier(x) && lookup(x.text) === 'aliased') ||
          ((ts.isElementAccessExpression(x) || ts.isPropertyAccessExpression(x)) && throughAlias(x.expression)),
      )
    // Whether a target passes through an entry on its way down.
    const passesEntry = (e: ts.Expression): boolean => {
      let x = unwrap(e)
      for (;;) {
        if (isEntry(x)) return true
        if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = unwrap(x.expression)
        else return false
      }
    }

    const siteOf = (n: ts.Node): string => {
      let x: ts.Node = n
      while (x.parent !== undefined && !ts.isSourceFile(x.parent)) x = x.parent
      if (ts.isFunctionDeclaration(x) || ts.isClassDeclaration(x)) return x.name?.text ?? '<anonymous>'
      if (ts.isVariableStatement(x)) {
        const d = x.declarationList.declarations[0]
        if (d !== undefined && ts.isIdentifier(d.name)) return d.name.text
      }
      return '<module>'
    }
    const record = (n: ts.Node, form: Form, why: string, value?: ts.Expression): void => {
      mutations.push({
        file,
        site: siteOf(n),
        form,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        why,
        ...(value === undefined ? {} : { value }),
      })
    }

    /** Classify a write to `target` (an assignment, a `delete`, `++` or `--`). */
    const write = (n: ts.Node, target: ts.Expression, form: 'assign' | 'delete', value?: ts.Expression): void => {
      const t = unwrap(target)
      const wholeMap = isRuns(t)
      const owner = ts.isElementAccessExpression(t) || ts.isPropertyAccessExpression(t) ? t.expression : undefined
      const intoMap = owner !== undefined && isRuns(owner)
      if (wholeMap || intoMap) {
        if (throughAlias(wholeMap || owner === undefined ? t : owner)) return
        // A whole map replaced by a literal that spreads a runs map: the
        // spread is part of this write, not a second finding.
        if (wholeMap && value !== undefined) {
          const v = unwrap(value)
          if (ts.isObjectLiteralExpression(v)) {
            for (const p of v.properties) if (ts.isSpreadAssignment(p) && isRuns(p.expression)) consumed.add(p)
          }
        }
        record(n, form, wholeMap ? 'replaces a whole runs map' : 'writes a runs map member', value)
        return
      }
      if (passesEntry(t)) {
        if (throughAlias(t)) return
        record(n, 'entry', 'changes an entry in place')
      }
    }

    const bindDeclaration = (d: ts.VariableDeclaration | ts.ParameterDeclaration, isParam: boolean): void => {
      if (ts.isIdentifier(d.name)) {
        if (isRunsType(sf, d.type)) {
          bind(d.name.text, 'runs')
          if (!isParam) record(d, 'alias', 'binds a runs map to a typed local')
          return
        }
        const init = d.initializer
        if (!isParam && init !== undefined) {
          const u = unwrap(init)
          const fromSpread =
            ts.isObjectLiteralExpression(u) &&
            u.properties.some((p) => ts.isSpreadAssignment(p) && isRuns(p.expression))
          if (isRuns(init) || fromSpread) {
            bind(d.name.text, 'aliased')
            record(d, 'alias', 'binds a runs map to a local')
            return
          }
          if (isEntry(init)) {
            bind(d.name.text, 'entry')
            return
          }
        }
        bind(d.name.text, 'other')
        return
      }
      // A binding pattern.
      const fromRuns = !isParam && d.initializer !== undefined && isRuns(d.initializer)
      let aliased = false
      const walkPattern = (p: ts.BindingName): void => {
        if (ts.isIdentifier(p)) {
          bind(p.text, fromRuns ? 'entry' : 'other')
          return
        }
        for (const el of p.elements) {
          if (ts.isOmittedExpression(el)) continue
          const key = ts.isObjectBindingPattern(p)
            ? propertyNameText(el.propertyName) ?? (ts.isIdentifier(el.name) ? el.name.text : undefined)
            : undefined
          if (key === 'plugin_runs' && ts.isIdentifier(el.name)) {
            bind(el.name.text, 'aliased')
            aliased = true
            continue
          }
          walkPattern(el.name)
        }
      }
      walkPattern(d.name)
      if (aliased || fromRuns) record(d, 'alias', 'destructures a runs map')
    }

    const visit = (n: ts.Node): void => {
      const scoped = opensScope(n)
      if (scoped) scopes.push(new Map())

      if (isFunctionLike(n)) for (const p of n.parameters) bindDeclaration(p, true)
      else if (ts.isVariableDeclaration(n)) bindDeclaration(n, false)
      else if (ts.isBinaryExpression(n) && isAssignmentOp(n.operatorToken.kind)) {
        write(n, n.left, 'assign', n.right)
      } else if (ts.isDeleteExpression(n)) {
        write(n, n.expression, 'delete')
      } else if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        write(n, n.operand, 'assign')
      } else if (ts.isCallExpression(n)) {
        const callee = calleeText(n.expression)
        const first = n.arguments[0]
        let skipFirst = false
        if (callee !== undefined && BUILTINS.has(callee) && first !== undefined && (isRuns(first) || isEntry(first))) {
          skipFirst = true
          if (!throughAlias(first)) record(n, 'builtin', `${callee} on a runs map`)
        }
        const target = unwrap(n.expression)
        if (ts.isPropertyAccessExpression(target) && isRuns(target.expression) && !throughAlias(target.expression)) {
          record(n, 'method', `calls ${target.name.text} on a runs map`)
        }
        n.arguments.forEach((arg, i) => {
          if ((i === 0 && skipFirst) || !isRuns(arg) || throughAlias(arg)) return
          if (callee !== undefined && READERS.has(callee)) return
          if (callee !== undefined && typedParams.get(callee)?.has(i) === true) return
          record(n, 'escape', `passes a runs map to ${callee ?? 'an unnamed callee'}`)
        })
      } else if ((ts.isSpreadAssignment(n) || ts.isSpreadElement(n)) && isRuns(n.expression)) {
        if (!consumed.has(n) && !throughAlias(n.expression)) record(n, 'spread', 'spreads a runs map')
      } else if (
        (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
        ts.isObjectLiteralExpression(n.parent) &&
        propertyNameText(n.name) === 'plugin_runs'
      ) {
        record(n, 'key', 'names plugin_runs in a new literal')
      }

      ts.forEachChild(n, visit)
      if (scoped) scopes.pop()
    }
    visit(sf)
  }

  const shapeHolds = (shape: Shape, value: ts.Expression | undefined): boolean => {
    if (value === undefined) return false
    const v = unwrap(value)
    if (!ts.isObjectLiteralExpression(v)) return false
    if (shape === 'routed') {
      const spreadsStamp = v.properties.some((p) => {
        if (!ts.isSpreadAssignment(p)) return false
        const e = unwrap(p.expression)
        return ts.isCallExpression(e) && calleeText(e.expression) === 'lastOutputOf'
      })
      return spreadsStamp && !namesAny(v, OUTPUT_FIELDS)
    }
    const first = v.properties[0]
    return first !== undefined && ts.isSpreadAssignment(first) && !namesAny(v, new Set(['run_id']))
  }

  /**
   * The first run a routed value stamps other than `stamp`, as source text, or
   * undefined when every `lastOutputOf` call it spreads passes `stamp`.
   */
  const strayStamp = (value: ts.Expression | undefined, stamp: string): string | undefined => {
    if (value === undefined) return undefined
    const v = unwrap(value)
    if (!ts.isObjectLiteralExpression(v)) return undefined
    for (const p of v.properties) {
      if (!ts.isSpreadAssignment(p)) continue
      const e = unwrap(p.expression)
      if (!ts.isCallExpression(e) || calleeText(e.expression) !== 'lastOutputOf') continue
      const text = e.arguments[2]?.getText() ?? '<nothing>'
      if (text !== stamp) return text
    }
    return undefined
  }

  const offenders: string[] = []
  const accepted = new Map<Recognised, number>()
  const misshapen = new Map<Recognised, number>()
  for (const m of mutations) {
    const where = `${m.form} at ${m.file}:${m.line} in ${m.site}`
    const row = allowlist.find((r) => r.file === m.file && r.site === m.site && r.form === m.form)
    if (row === undefined) {
      offenders.push(`${where}: ${m.why}, and no row recognises it`)
      continue
    }
    if (row.shape !== undefined && !shapeHolds(row.shape, m.value)) {
      offenders.push(`${where}: ${m.why}, and its value is not the ${row.shape} shape`)
      misshapen.set(row, (misshapen.get(row) ?? 0) + 1)
      continue
    }
    const stray = row.stamp === undefined ? undefined : strayStamp(m.value, row.stamp)
    if (stray !== undefined) {
      offenders.push(`${where}: ${m.why}, and it stamps ${stray} where its row stamps ${row.stamp}`)
      misshapen.set(row, (misshapen.get(row) ?? 0) + 1)
      continue
    }
    accepted.set(row, (accepted.get(row) ?? 0) + 1)
  }
  for (const row of allowlist) {
    const n = accepted.get(row) ?? 0
    // A shortfall the misshapen writes at the same site account for is already
    // reported, once per write, above. Anything else is a row out of step with
    // the source: a site that is gone, or more of them than it recognises.
    const explained = n < row.count && n + (misshapen.get(row) ?? 0) >= row.count
    if (n !== row.count && !explained) {
      offenders.push(`${row.form} at ${row.file} in ${row.site}: the row expects ${row.count}, the scan found ${n}`)
    }
  }
  return offenders
}

/** Every tracked non-test `.ts` file under `src/`, by repo-relative path. */
function trackedSources(): Map<string, string> {
  const listed = execFileSync('git', ['ls-files', '--', 'src'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('/__tests__/'))
  if (listed.length === 0) throw new Error('blind: git ls-files found no source under src/')
  return new Map(listed.map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf-8')]))
}

/**
 * The recognised writers as they look once they all route through one place.
 * `/*PLANT*\/` is where a planted write goes inside `runAdvance`.
 */
const RECOGNISED_ENGINE = `
import type { EngineState } from '../schemas/engine-state.js'

export async function runAdvance(state: EngineState, disk: EngineState, ranThisAdvance: Map<string, unknown>, run_id: string, r: unknown, p: string) {
  const priorThrownEntry = state.plugin_runs[p]
  state.plugin_runs[p] = { last_run_at: 't', status: 'failed', ...lastOutputOf(null, priorThrownEntry, run_id) }
  const priorGatedEntry = state.plugin_runs[p]
  state.plugin_runs[p] = { last_run_at: 't', status: 'gated', ...lastOutputOf(r, priorGatedEntry, run_id) }
  const prior = state.plugin_runs[p]
  state.plugin_runs[p] = { last_run_at: 't', status: 'success', ...lastOutputOf(r, prior, run_id) }
  /*PLANT*/
  const merged: EngineState = {
    ...disk,
    plugin_runs: mergePluginRuns(disk.plugin_runs, state.plugin_runs, ranThisAdvance, run_id),
  }
  eraseReleasedContent(merged.plugin_runs, merged.pending_gates)
}

export async function applyPendingGate(state: EngineState, gate: { plugin: string; run_id: string; plugin_result: unknown }) {
  const discard = async () => {
    delete state.plugin_runs[gate.plugin]
  }
  const priorApprovedEntry = state.plugin_runs[gate.plugin]
  state.plugin_runs[gate.plugin] = {
    last_run_at: 't',
    status: 'success',
    ...lastOutputOf(gate.plugin_result, priorApprovedEntry, gate.run_id),
  }
}

function mergePluginRuns(
  disk: EngineState['plugin_runs'],
  memory: EngineState['plugin_runs'],
  ran: ReadonlyMap<string, unknown>,
  runId: string,
): EngineState['plugin_runs'] {
  const merged: EngineState['plugin_runs'] = { ...disk }
  for (const [plugin, result] of ran) {
    const { last_output: _carried, ...entry } = memory[plugin]!
    const fresh = Object.hasOwn(disk, plugin) ? disk[plugin] : undefined
    merged[plugin] = { ...entry, ...lastOutputOf(result, fresh, runId) }
  }
  return merged
}

function eraseReleasedContent(pluginRuns: EngineState['plugin_runs'], pendingGates: unknown[]): void {
  for (const plugin of Object.keys(pluginRuns)) eraseIfReleased(pluginRuns, pendingGates, plugin)
}

export function eraseIfReleased(pluginRuns: EngineState['plugin_runs'], pendingGates: unknown[], plugin: string): void {
  const run = Object.hasOwn(pluginRuns, plugin) ? pluginRuns[plugin] : undefined
  if (run === undefined) return
  pluginRuns[plugin] = { ...run, last_output: { type: 'brief', erased_at: 't' } }
}
`

const RECOGNISED_SCHEMA = `
import { z } from 'zod'
export const EngineStateSchema = z.object({
  plugin_runs: z.record(z.string(), PluginRunSchema).default({}),
})
`

function fixture(opts: { plant?: string; module?: string; engine?: string } = {}): Map<string, string> {
  const engine = (opts.engine ?? RECOGNISED_ENGINE).replace('/*PLANT*/', opts.plant ?? '') + (opts.module ?? '')
  return new Map([
    ['src/runtime/engine.ts', engine],
    ['src/schemas/engine-state.ts', RECOGNISED_SCHEMA],
  ])
}

// ── The writers that record a run other than their own ─────────────────────

/** The names a writer's own run goes by: `runAdvance`'s and `mergePluginRuns`'s. */
const OWN_RUN_STAMPS: ReadonlySet<string> = new Set(['run_id', 'runId'])

type Driver = () => Promise<void>

/**
 * The driver of every row that stamps a run other than the writer's own. The
 * rows are selected by their stamp and never flagged by hand, so a new one
 * cannot leave the flag off. Throws on a selected row with no driver, before
 * any driver runs, and throws when nothing is selected, since an empty
 * selection is "did not look".
 */
function supersessionCases(rows: readonly Recognised[], drivers: Readonly<Record<string, Driver>>): Driver[] {
  const foreign = rows.filter((r) => r.stamp !== undefined && !OWN_RUN_STAMPS.has(r.stamp))
  if (foreign.length === 0) throw new Error('blind: no row stamps a run other than its own')
  return foreign.map((r) => {
    const key = `${r.file}#${r.site}`
    if (!Object.hasOwn(drivers, key)) {
      throw new Error(
        `no supersession case for ${r.site}: a writer that records a run other than its own must prove it refuses an entry a later run wrote`,
      )
    }
    return drivers[key]!
  })
}

/**
 * One driver per writer that records a run other than its own, keyed
 * `<file>#<site>`. Each proves the writer refuses an entry a later run wrote,
 * and keeps that entry as the later run left it.
 */
const SUPERSEDED_BY_A_LATER_RUN: Readonly<Record<string, Driver>> = {
  'src/runtime/engine.ts#applyPendingGate': async () => {
    const h = await setup({ review_gate: true })
    const parked = await advance(h)
    expect((await persisted(h))['run_id']).toBe(parked.run_id)

    // A later run whose invocation throws parks nothing, so the gate is still
    // pending, and the entry is that later run's.
    await mkdir(join(h.root, 'config', `${PLUGIN}.json`), { recursive: true })
    const later = await advance(h, { force: true })
    const failed = await persisted(h)
    expect(failed.status).toBe('failed')
    expect(failed['run_id']).toBe(later.run_id)
    expect(failed.last_output?.run_id).toBe(parked.run_id)

    const applied = await approve([PLUGIN])
    expect(applied.code, applied.output).toBe(1)
    expect(applied.output).toContain('ran again after this result was parked')

    const kept = await persisted(h)
    expect(kept['run_id']).toBe(later.run_id)
    expect(kept.status).toBe('failed')
    expect(kept.last_output?.run_id).toBe(parked.run_id)
    const state = JSON.parse(await readFile(join(h.stateDir, 'engine-state.json'), 'utf-8')) as EngineState
    expect(state.pending_gates.filter((g) => g.plugin === PLUGIN && g.applied_at === null)).toEqual([])
  },
}

describe('every writer of a run entry records the run that wrote it', () => {
  test('an autonomous run records its own run', async () => {
    const h = await setup()

    const r = await advance(h)

    const entry = await persisted(h)
    expect(entry.status).toBe('success')
    expect(entry['run_id']).toBe(r.run_id)
    expect(entry.last_output?.run_id).toBe(r.run_id)
  })

  test('an invocation that threw records its own run, and the Output it carried names an earlier one', async () => {
    const h = await setup()
    const r1 = await advance(h)

    // Make the plugin's config path a directory: `readFile` raises EISDIR,
    // which `loadPluginConfig` rethrows raw, so `invokePlugin` throws out of
    // the engine's try and the thrown arm writes the entry.
    await mkdir(join(h.root, 'config', `${PLUGIN}.json`), { recursive: true })
    const r2 = await advance(h, { force: true })

    const entry = await persisted(h)
    expect(entry.status).toBe('failed')
    expect(r2.run_id).not.toBe(r1.run_id)
    expect(entry['run_id']).toBe(r2.run_id)
    expect(entry.last_output?.run_id).toBe(r1.run_id)
  })

  test('a gated run and the apply that records it both name the run that parked it', async () => {
    const h = await setup({ review_gate: true })

    const parked = await advance(h)

    const gated = await persisted(h)
    expect(gated.status).toBe('gated')
    expect(gated['run_id']).toBe(parked.run_id)

    const applied = await approve([PLUGIN])
    expect(applied.code, applied.output).toBe(0)

    const entry = await persisted(h)
    expect(entry.status).toBe('success')
    expect(entry['run_id']).toBe(parked.run_id)
    expect(entry.last_output?.run_id).toBe(parked.run_id)
  })

  test('every write to a runs map in src is one the census recognises', () => {
    expect(runsMapWriteOffenders(trackedSources(), RECOGNISED)).toEqual([])
  })

  test('the census reports a write it does not recognise, in every form it can take', () => {
    const planted: Array<{ form: Form; plant?: string; module?: string }> = [
      { form: 'builtin', plant: 'Object.assign(state.plugin_runs, { [p]: prior })' },
      { form: 'assign', plant: 'state.plugin_runs = { ...state.plugin_runs, [p]: prior! }' },
      {
        form: 'alias',
        plant: 'const runs = state.plugin_runs\n  runs[p] = { ...lastOutputOf(r, prior, run_id) }',
      },
      { form: 'builtin', plant: 'Reflect.set(state.plugin_runs, p, prior)' },
      { form: 'alias', plant: 'const { plugin_runs: runs } = state\n  delete runs[p]' },
      { form: 'entry', plant: 'state.plugin_runs[p]!.last_output = out' },
      {
        form: 'escape',
        plant: 'stash(state.plugin_runs)',
        module: '\nfunction stash(m: any) {\n  return m\n}\n',
      },
      {
        form: 'assign',
        module: `
export function sideDoor(state: EngineState, p: string, r: unknown, t: string, id: string) {
  state.plugin_runs[p] = { last_run_at: t, status: 'success', ...lastOutputOf(r, undefined, id) }
}
`,
      },
    ]
    for (const { form, plant, module } of planted) {
      const offenders = runsMapWriteOffenders(fixture({ plant, module }), RECOGNISED)
      expect(offenders, `${plant ?? module}`).toHaveLength(1)
      expect(offenders[0]!, `${plant ?? module}`).toStartWith(`${form} at `)
    }

    // A routed write that stamps an earlier run. The shape rule looks only at
    // property assignments, never at a read such as `prior!.run_id!`, so only
    // the stamp rule can report this one.
    const misStamped = runsMapWriteOffenders(
      fixture({
        plant: "state.plugin_runs[p] = { last_run_at: 't', status: 'success', ...lastOutputOf(r, prior, prior!.run_id!) }",
      }),
      RECOGNISED,
    )
    expect(misStamped).toHaveLength(1)
    expect(misStamped[0]!).toStartWith('assign at ')
    expect(misStamped[0]!).toContain('where its row stamps run_id')
  })

  test('every writer that records a run other than its own refuses an entry a later run wrote', async () => {
    for (const drive of supersessionCases(RECOGNISED, SUPERSEDED_BY_A_LATER_RUN)) await drive()
  })

  test("a row stamping a run other than the writer's own is refused until it has a supersession case", () => {
    const row: Recognised = {
      file: 'src/runtime/engine.ts',
      site: 'sideDoor',
      form: 'assign',
      count: 1,
      shape: 'routed',
      stamp: 'prior.run_id',
    }
    expect(() => supersessionCases([...RECOGNISED, row], SUPERSEDED_BY_A_LATER_RUN)).toThrow(
      'no supersession case for sideDoor',
    )
    const withDriver = { ...SUPERSEDED_BY_A_LATER_RUN, 'src/runtime/engine.ts#sideDoor': async () => {} }
    expect(() => supersessionCases([...RECOGNISED, row], withDriver)).not.toThrow()

    // The two "did not look" throws the real tree never reaches.
    expect(() => supersessionCases([], {})).toThrow('blind: no row stamps a run other than its own')
    const unstamped = RECOGNISED.map((r) => (r.site === 'mergePluginRuns' && r.shape === 'routed' ? { ...r, stamp: undefined } : r))
    expect(() => runsMapWriteOffenders(fixture(), unstamped)).toThrow('names no stamp')
  })

  test('the census recognises the writers as they look once they all route through one place', () => {
    expect(runsMapWriteOffenders(fixture(), RECOGNISED)).toEqual([])

    const erasure = "  pluginRuns[plugin] = { ...run, last_output: { type: 'brief', erased_at: 't' } }\n"
    expect(RECOGNISED_ENGINE).toContain(erasure)
    const stale = runsMapWriteOffenders(fixture({ engine: RECOGNISED_ENGINE.replace(erasure, '') }), RECOGNISED)
    expect(stale).toEqual([
      'assign at src/runtime/engine.ts in eraseIfReleased: the row expects 1, the scan found 0',
    ])
  })
})
