/**
 * The half of the scope registry that only a compiler can check.
 *
 * `index.test.ts` proves things about VALUES: which entries carry a `deprecated` reason, that the
 * reason cites a route, that micro-org's textual parser reads the same entries this file's runtime
 * helpers do. None of that can prove the thing an outbound declaration actually needs — that
 * `const CUSTODY_SCOPES: readonly LiveScope[] = Object.freeze(['wallet:provision'])` does not
 * COMPILE. A type-level guarantee has no runtime shadow to assert against: `tsx` strips the
 * annotations, so a test that merely writes that line passes whatever the type says, and
 * `@ts-expect-error` proves the opposite of what is wanted here — it passes when the error is
 * absent from a DIFFERENT line and it is invisible to `node --test` either way.
 *
 * So this suite runs the compiler. It generates fixture modules from the registry as it is at
 * runtime, type-checks them with the package's own `tsconfig.base.json` (strict,
 * `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — the settings every consumer builds
 * under), and asserts the EXACT set of file/line pairs tsc reports an error on. Exact, in both
 * directions: a line that should be rejected and is not fails, and a line that should compile and
 * does not fails too. A harness that could only look for errors would pass if tsc never ran.
 *
 * The two obligations, and which test carries each:
 *
 *   1. A deprecated scope must not be assignable where a live one is required —
 *      `a deprecated scope cannot be written where a live scope is required`.
 *   2. The deprecated SET must not drift from the registry —
 *      `the live and dead types are the registry's own answer, not a second copy of it`.
 *      The second is the reason `DeprecatedScope` is a conditional type over `SCOPES` and not a
 *      union anybody maintains, and this test is what keeps the derivation honest: the expected
 *      unions below are built at runtime by `isDeprecatedScope`, which reads the property, and
 *      compared against the type, which reads the property's TYPE. Two readings of one field. If
 *      the registry gains, loses or reshapes a deprecation, both move together or this goes red;
 *      no list here is written by hand.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SCOPE_NAMES, isDeprecatedScope } from './index.ts'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The compiler this package is built with, found the same way `pnpm` finds it — the nearest
 * `node_modules/.bin` up the tree. Located rather than assumed, and FATAL when absent: the one
 * failure this file must never have is passing because it silently did not run.
 */
function locateTsc(): string {
  let dir = PACKAGE_DIR
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `no node_modules/.bin/tsc above ${PACKAGE_DIR} — the type-level assertions in this file cannot be checked, and a suite that skips them is a suite that proves nothing`,
  )
}

interface Diagnostic {
  readonly file: string
  readonly line: number
  readonly code: string
  readonly message: string
}

/** `file.ts(12,7): error TS2322: ...`, which is what tsc prints with `--pretty false`. */
function parseDiagnostics(output: string): readonly Diagnostic[] {
  const found: Diagnostic[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/)
    if (match) {
      found.push({
        file: match[1] ?? '',
        line: Number(match[2]),
        code: match[3] ?? '',
        message: match[4] ?? '',
      })
    }
  }
  return found
}

/**
 * Type-check `files` in a throwaway project beside the package, and return every diagnostic.
 *
 * The project extends the real `tsconfig.base.json` rather than restating flags: a fixture checked
 * under looser settings than its consumers build with would prove something about a compiler
 * nobody runs. The directory sits inside the package so `../src/index.ts` resolves exactly as a
 * sibling module does, and outside `src/` so `pnpm typecheck` — whose `include` is `src/**\/*` —
 * never sees a fixture that is MEANT to fail.
 */
function typecheck(files: Readonly<Record<string, string>>): readonly Diagnostic[] {
  const dir = mkdtempSync(join(PACKAGE_DIR, '.type-tests-'))
  try {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify(
        { extends: '../../../tsconfig.base.json', compilerOptions: { noEmit: true }, include: ['./*.ts'] },
        null,
        2,
      ),
    )
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)

    let output: string
    try {
      output = execFileSync(locateTsc(), ['--noEmit', '--pretty', 'false', '-p', dir], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch (error) {
      // tsc exits 2 when it reported errors. Anything without captured stdout is tsc failing to
      // run at all, and that must not read as "no errors found".
      const failure = error as { readonly stdout?: string; readonly stderr?: string; readonly message?: string }
      if (typeof failure.stdout !== 'string') {
        throw new Error(`tsc could not be run: ${failure.stderr ?? failure.message ?? 'no output'}`)
      }
      output = failure.stdout
    }
    const diagnostics = parseDiagnostics(output)
    // A compiler complaint that is not about a fixture line — a missing config, an unresolved
    // import — would otherwise be counted as one of the rejections this file is asserting.
    for (const diagnostic of diagnostics) {
      assert.ok(
        Object.hasOwn(files, diagnostic.file),
        `tsc reported ${diagnostic.code} against ${diagnostic.file}, which is not a fixture: ${diagnostic.message}`,
      )
    }
    return diagnostics
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const DEPRECATED = SCOPE_NAMES.filter((scope) => isDeprecatedScope(scope))
const LIVE = SCOPE_NAMES.filter((scope) => !isDeprecatedScope(scope))

/**
 * Floors, for the reason `estate-scopes.mjs` has them: every assertion below is a loop over one of
 * these two lists, and a loop over an empty list passes while proving nothing. If the registry ever
 * has no dead entries these tests must be deleted deliberately, not pass vacuously.
 */
test('the registry still has both halves for these fixtures to be about', () => {
  assert.ok(DEPRECATED.length > 0, 'no deprecated scope in the registry — every rejection fixture below would be empty')
  assert.ok(LIVE.length > 20, `only ${LIVE.length} live scopes — the registry is not being read`)
  assert.equal(DEPRECATED.length + LIVE.length, SCOPE_NAMES.length)
})

test('a deprecated scope cannot be written where a live scope is required', () => {
  const header = [
    "import type { LiveScope, Scope } from '../src/index.ts'",
    'declare function mint(scopes: readonly LiveScope[]): void',
  ]

  // Three shapes, because the estate writes all three: the scalar, the frozen array an outbound
  // constant is declared as (`micro-market`/`micro-wallet`), and the call site that hands scopes to
  // a token exchange (`beacon/src/ecosystem.ts`). Each generated line is expected to be red.
  const rejected: string[] = []
  const expected = new Set<number>()
  for (const scope of DEPRECATED) {
    rejected.push(`export const scalar_${rejected.length}: LiveScope = '${scope}'`)
    expected.add(header.length + rejected.length)
    rejected.push(
      `export const declared_${rejected.length}: readonly LiveScope[] = Object.freeze(['${scope}'])`,
    )
    expected.add(header.length + rejected.length)
    rejected.push(`mint(['${scope}'])`)
    expected.add(header.length + rejected.length)
  }

  // The same three shapes with live scopes, plus the widening every consumer relies on: a
  // `LiveScope` must still go wherever a `Scope` goes, or this type would be a breaking change
  // wearing an additive one's clothes.
  const accepted = [
    ...LIVE.map((scope, index) => `export const ok_${index}: LiveScope = '${scope}'`),
    `export const all: readonly LiveScope[] = Object.freeze([${LIVE.map((s) => `'${s}'`).join(', ')}])`,
    `mint([${LIVE.map((s) => `'${s}'`).join(', ')}])`,
    'export const wide: readonly Scope[] = all',
    "export const one: Scope = ok_0",
  ]

  const diagnostics = typecheck({
    'rejected.ts': [...header, ...rejected].join('\n') + '\n',
    'accepted.ts': [...header, ...accepted].join('\n') + '\n',
  })

  const onAccepted = diagnostics.filter((d) => d.file === 'accepted.ts')
  assert.deepEqual(
    onAccepted.map((d) => `${d.line}: ${d.code} ${d.message}`),
    [],
    'a LIVE scope was refused, or stopped being usable where a Scope is expected — this type is supposed to be additive',
  )

  const onRejected = diagnostics.filter((d) => d.file === 'rejected.ts')
  assert.deepEqual(
    [...new Set(onRejected.map((d) => d.line))].sort((a, b) => a - b),
    [...expected].sort((a, b) => a - b),
    `every line of rejected.ts must be a compile error and nothing else may be:\n${[...header, ...rejected].map((l, i) => `${i + 1}: ${l}`).join('\n')}\n\ngot:\n${onRejected.map((d) => `${d.line}: ${d.code} ${d.message}`).join('\n')}`,
  )
  // Red for the right reason. An unresolved import or a syntax slip would put an error on every
  // line of the file and satisfy the set comparison above on its own.
  for (const diagnostic of onRejected) {
    assert.match(
      diagnostic.message,
      /LiveScope/,
      `line ${diagnostic.line} is red, but not because the scope is not a LiveScope: ${diagnostic.code} ${diagnostic.message}`,
    )
  }
})

test('the live and dead types are the registry\'s own answer, not a second copy of it', () => {
  // `[A] extends [B]` — tupled, so a union distributes over nothing and this is genuine set
  // equality rather than "some member matches".
  const union = (names: readonly string[]) => (names.length === 0 ? 'never' : names.map((n) => `'${n}'`).join(' | '))
  const source = [
    "import type { DeprecatedScope, LiveScope, Scope } from '../src/index.ts'",
    'type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false',
    // Expected sides built from the RUNTIME derivation — `isDeprecatedScope`, reading the property
    // off the frozen object — and compared against the TYPE-level derivation. Neither side is
    // written down here; both are computed from the registry, by different machinery.
    `export const deprecatedMatchesRegistry: Exact<DeprecatedScope, ${union(DEPRECATED)}> = true`,
    `export const liveMatchesRegistry: Exact<LiveScope, ${union(LIVE)}> = true`,
    // And the two halves still partition the whole: a scope that fell out of both would be
    // invisible to the pair of assertions above if they were checked one at a time.
    'export const halvesPartitionTheRegistry: Exact<DeprecatedScope | LiveScope, Scope> = true',
  ]

  const diagnostics = typecheck({ 'drift.ts': source.join('\n') + '\n' })
  assert.deepEqual(
    diagnostics.map((d) => `${d.line} (${source[d.line - 1] ?? '?'}): ${d.code} ${d.message}`),
    [],
    'the type-level deprecated set and the registry disagree — one of `DeprecatedScope` and `isDeprecatedScope` has stopped reading the `deprecated` field',
  )
})

/**
 * The nothing case, which has to be sayable for "declare exactly what you need" to be honest.
 *
 * `micro-wallet`'s `PRICING_SCOPES` declares `pricing:read` for an upstream route that is ungated,
 * because an empty declaration is read as a forgotten one. The constant is checked here for the
 * two properties a consumer will lean on: it is empty at runtime, and it satisfies the
 * `readonly LiveScope[]` annotation an outbound constant carries — so switching to it is a change
 * of value, not a change of shape.
 */
test('a client whose upstream needs nothing can say so', async () => {
  const { NO_SCOPES_REQUIRED } = await import('./index.ts')
  assert.deepEqual([...NO_SCOPES_REQUIRED], [])
  assert.throws(() => {
    // @ts-expect-error frozen and readonly; this is the runtime half
    NO_SCOPES_REQUIRED.push('ledger:read')
  })

  const diagnostics = typecheck({
    'nothing.ts': [
      "import { NO_SCOPES_REQUIRED } from '../src/index.ts'",
      "import type { LiveScope } from '../src/index.ts'",
      'export const PRICING_SCOPES: readonly LiveScope[] = NO_SCOPES_REQUIRED',
    ].join('\n') + '\n',
  })
  assert.deepEqual(
    diagnostics.map((d) => `${d.line}: ${d.code} ${d.message}`),
    [],
    'NO_SCOPES_REQUIRED does not satisfy the annotation an outbound constant carries',
  )
})
