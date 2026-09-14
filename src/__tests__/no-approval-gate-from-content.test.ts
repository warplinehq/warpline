/**
 * Nothing on the content-approval path reaches the session-grant machinery.
 *
 * FREEZE-10 names three artifacts: every symbol `src/runtime/approval-gate.ts`
 * exports, plus `applyPendingGate` and `PendingGateSchema`, which are declared
 * elsewhere. The guarantee is REACHABILITY, not byte equality — the gate module
 * and the two symbols beside it stay live and keep every caller they have
 * today; what they must not acquire is a caller inside the content branch. A
 * check written as a byte comparison would have been wrong on its first day,
 * because the same milestone edits one of those three on purpose.
 *
 * These names are forbidden to the content path, not permitted to it: the set
 * below is the thing the walk must never meet, and it is built by enumeration
 * so a ninth export added tomorrow is covered without anyone remembering.
 *
 * **Why an AST walk and not a grep.** A file-granularity import closure — the
 * shape `src/cli/__tests__/deny.test.ts:498-551` uses — is already non-empty
 * from every plausible root in this tree, because `engine.ts:22` imports
 * `checkApproval` for a legitimate session-grant call that must stay. A
 * file-level predicate could therefore only be made green by a hand list of
 * blessed call sites, which `src/__tests__/no-orphan-schema-fields.test.ts:19-20`
 * rejects by name. So the unit of analysis is the FUNCTION: start at the four
 * named module-level functions the content branch lives in, walk their bodies
 * and the bodies of everything they call, and assert the identifiers met along
 * the way name none of the forbidden set.
 *
 * This is the repository's first AST-based guard. `typescript` is already a
 * devDependency (`package.json:68`) and
 * `src/cli/__tests__/manifest-declarative.test.ts:97-110` sanctions reaching
 * for `ts.createSourceFile` when a line-oriented scan stops being enough. A
 * syntactic `SourceFile` is enough for a name-level assertion; no `Program` and
 * no type checker, which keeps the walk far inside the suite's 20 s default.
 *
 * **Every enumeration here throws rather than returning empty.** An enumeration
 * that found nothing is "did not look", and returning `[]` from it reports
 * silently, perfectly green — the discipline
 * `src/__tests__/no-grant-recheck.test.ts:56-66` states in its own words, and
 * the failure class this repository has now logged six instances of. That
 * covers the export enumeration, the two named-elsewhere declarations, the
 * roots, and the closure itself.
 *
 * The closure walker takes its source texts rather than reading them, so the
 * identical code runs against the real tree (must return `[]`) and against
 * deliberately broken in-memory fixtures (must report the break). That symmetry
 * is what makes "this check goes red" provable rather than assumed.
 *
 * Why a test rather than a lint script: `bun test` is the command CI runs and
 * the one the contributor guide names, so the check cannot be skipped by
 * forgetting a second command.
 *
 * Reads source files under the repository root and writes nothing.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as ts from 'typescript'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SRC = join(REPO_ROOT, 'src')

const FIND = '/usr/bin/find'

const APPROVAL_GATE = join(SRC, 'runtime', 'approval-gate.ts')
const ENGINE = join(SRC, 'runtime', 'engine.ts')
const ENGINE_STATE = join(SRC, 'schemas', 'engine-state.ts')

/**
 * The content branch's entry points, by name.
 *
 * Structural: these are declarations the compiler can find, not a comment
 * anchor and not a hand-kept list of line numbers. A refactor that inlines one
 * of them back into its caller makes this guard throw rather than pass.
 */
const CONTENT_ROOTS = [
  'approvalStanding',
  'contentEffectId',
  'contentGateApplies',
  'contentGateDetail',
] as const

/**
 * The two artifacts FREEZE-10 names that are NOT declared in the gate module,
 * paired with where the requirement says each one lives.
 *
 * An enumeration of `approval-gate.ts`'s exports covers neither, so a content
 * root that called `applyPendingGate` or read `PendingGateSchema` would leave
 * such a guard green over exactly the reach it was written to have.
 */
const NAMED_ELSEWHERE: readonly (readonly [string, string])[] = [
  ['applyPendingGate', ENGINE],
  ['PendingGateSchema', ENGINE_STATE],
]

type Decl = { readonly node: ts.Node; readonly exported: boolean }

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

/**
 * Every module-level declaration in a file, by name.
 *
 * One enumeration serving four callers — the export set, the two
 * named-elsewhere existence checks, the root lookup, and the recursion target
 * lookup — so all four agree on what "declared here" means.
 */
function topLevelDecls(sf: ts.SourceFile): Map<string, Decl> {
  const out = new Map<string, Decl>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      if (st.name !== undefined) out.set(st.name.text, { node: st, exported: hasExportModifier(st) })
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.set(d.name.text, { node: d, exported: hasExportModifier(st) })
      }
    } else if (
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st)
    ) {
      out.set(st.name.text, { node: st, exported: hasExportModifier(st) })
    }
  }
  return out
}

/**
 * Whether a declaration carries code the walk should descend into.
 *
 * Functions, arrow/function consts and classes, and deliberately not types or
 * plain data. Descending into a type alias would drag the whole state schema in
 * behind `EngineState` and report a breach for a root that merely names the
 * type it is handed — a reachability claim about calls, answered with a claim
 * about type structure.
 */
function descendable(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return true
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer
    return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
  }
  return false
}

/**
 * Imported binding name to the absolute path of the file it comes from, for
 * relative specifiers only.
 *
 * `.js` is rewritten to `.ts` the way `src/cli/__tests__/deny.test.ts:513-542`
 * does it — the sources are ESM-specified TypeScript, so the specifier names
 * the built artifact and the declaration lives beside it.
 *
 * ponytail: static `import` declarations only. A binding destructured out of a
 * dynamic `import()` is still COLLECTED as an identifier wherever it is named,
 * so a forbidden symbol cannot hide behind one; what the walk declines to do is
 * descend through it. Widen this if a content root ever acquires a dynamic
 * import of a local helper.
 */
function relativeImports(sf: ts.SourceFile, file: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue
    const spec = st.moduleSpecifier
    if (!ts.isStringLiteral(spec) || !spec.text.startsWith('.')) continue
    const clause = st.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    const bindings = clause.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    const target = resolve(dirname(file), spec.text.replace(/\.js$/, '.ts'))
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue
      out.set(el.name.text, target)
    }
  }
  return out
}

/**
 * `<file>#<function>: <symbol>` for every forbidden name met while walking the
 * transitive closure of `roots`, sorted and deduplicated.
 *
 * PURE, and it takes its source texts as a map rather than reading them, so the
 * identical code runs against the real tree and against a fixture built in
 * memory. Nothing in here throws for a reason specific to the real tree — the
 * existence checks that are specific to it live in the builders below, because
 * a throw in here would redden every fixture case instead.
 *
 * Recursion follows any identifier naming a descendable module-level
 * declaration, not only a call callee: `list.forEach(writeGrant)` passes a
 * function without ever wearing call shape, and a walk that insisted on the
 * parentheses would stop at the wall.
 */
function offendingSymbols(
  sources: ReadonlyMap<string, string>,
  rootFile: string,
  roots: readonly string[],
  forbidden: ReadonlySet<string>,
): string[] {
  const parsed = new Map<string, ts.SourceFile>()
  const parse = (file: string): ts.SourceFile => {
    const cached = parsed.get(file)
    if (cached !== undefined) return cached
    const text = sources.get(file)
    if (text === undefined) {
      throw new Error(`blind: ${file} is not in the source map, so the walk cannot see inside it`)
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
    parsed.set(file, sf)
    return sf
  }

  const visited = new Set<string>()
  const offenders = new Set<string>()

  const label = (file: string): string =>
    file.startsWith(`${REPO_ROOT}/`) ? file.slice(REPO_ROOT.length + 1) : file

  function descend(file: string, name: string): void {
    const key = `${file}#${name}`
    if (visited.has(key)) return
    visited.add(key)

    const sf = parse(file)
    const decls = topLevelDecls(sf)
    const decl = decls.get(name)
    if (decl === undefined) return
    const imports = relativeImports(sf, file)

    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const text = node.text
        if (forbidden.has(text)) offenders.add(`${label(file)}#${name}: ${text}`)
        const local = decls.get(text)
        if (local !== undefined) {
          if (descendable(local.node)) descend(file, text)
        } else {
          const from = imports.get(text)
          if (from !== undefined) {
            const target = topLevelDecls(parse(from)).get(text)
            if (target !== undefined && descendable(target.node)) descend(from, text)
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(decl.node)
  }

  const rootDecls = topLevelDecls(parse(rootFile))
  for (const root of roots) {
    if (rootDecls.get(root) === undefined) {
      throw new Error(`blind: root ${root} is not declared in ${label(rootFile)}`)
    }
    descend(rootFile, root)
  }

  if (visited.size === 0) {
    throw new Error('blind: the closure walk visited no declaration at all')
  }

  return [...offenders].sort()
}

/**
 * Every non-test source file under `src/`, by absolute path.
 *
 * `/usr/bin/find` by absolute path, never the bare name: the bare name resolves
 * to ugrep on a developer machine here, which honours ignore files when it
 * walks a directory itself and has already returned a false zero over this
 * repository once.
 */
function realSources(): Map<string, string> {
  const out = execFileSync(FIND, [SRC, '-name', '*.ts', '-not', '-path', '*__tests__*'], {
    encoding: 'utf8',
  })
  const files = out.split('\n').filter(Boolean)
  if (files.length === 0) {
    throw new Error('blind: no source file enumerated under src/')
  }
  return new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
}

/**
 * The forbidden set: the gate module's exports, THEN the two names FREEZE-10
 * lists outside it.
 *
 * The order is load-bearing. The enumeration still throws on empty, and the two
 * additions read as additive rather than as a replacement for it. Each of the
 * two is confirmed to be a live exported declaration where the requirement says
 * it is — a forbidden name that no longer exists forbids nothing, which is the
 * same did-not-look failure as an empty enumeration and would turn the pair
 * into decoration on the next rename.
 *
 * If the assertion below ever reports one of these names, that is a finding.
 * Dropping the name to make it green is the failure this guard exists to
 * prevent.
 */
function forbiddenSymbols(sources: ReadonlyMap<string, string>): Set<string> {
  const read = (file: string): ts.SourceFile => {
    const text = sources.get(file)
    if (text === undefined) throw new Error(`blind: ${file} is absent from the source enumeration`)
    return ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  }

  const exported = [...topLevelDecls(read(APPROVAL_GATE))]
    .filter(([, d]) => d.exported)
    .map(([name]) => name)
  if (exported.length === 0) {
    throw new Error('blind: no exported symbol enumerated from approval-gate.ts')
  }

  const set = new Set(exported)
  for (const [name, file] of NAMED_ELSEWHERE) {
    const decl = topLevelDecls(read(file)).get(name)
    if (decl === undefined || !decl.exported) {
      throw new Error(`blind: ${name} is not declared in ${file} — a forbidden name that no longer exists forbids nothing`)
    }
    set.add(name)
  }
  return set
}

const REAL_SOURCES = realSources()
const REAL_FORBIDDEN = forbiddenSymbols(REAL_SOURCES)

describe('no approval-gate symbol is reachable from the content-approval path', () => {
  test('the content branch closure names none of the forbidden symbols', () => {
    expect(offendingSymbols(REAL_SOURCES, ENGINE, CONTENT_ROOTS, REAL_FORBIDDEN)).toEqual([])
  })

  /**
   * The positive controls. Without them the assertion above is green whenever
   * an enumeration quietly produced nothing, which is indistinguishable from
   * clean at the point it matters.
   */
  test('the four content roots are still declared in engine.ts', () => {
    const decls = topLevelDecls(
      ts.createSourceFile(ENGINE, REAL_SOURCES.get(ENGINE) ?? '', ts.ScriptTarget.ES2022, true),
    )
    expect(CONTENT_ROOTS.filter((r) => decls.has(r))).toEqual([...CONTENT_ROOTS])
  })

  test('the forbidden set covers all three artifacts the requirement names', () => {
    // Eight exports from the gate module plus the two declared elsewhere. A
    // count alone cannot tell a ninth gate export from a union that failed to
    // land, so both names are asserted directly beside it.
    expect(REAL_FORBIDDEN.size).toBeGreaterThanOrEqual(10)
    expect(REAL_FORBIDDEN.has('applyPendingGate')).toBe(true)
    expect(REAL_FORBIDDEN.has('PendingGateSchema')).toBe(true)
    expect(REAL_FORBIDDEN.has('checkApproval')).toBe(true)
  })
})
