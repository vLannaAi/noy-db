# Field-metadata Plan 1 — zod-4 substrate (#482) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@noy-db/hub` first-class on zod 4 without breaking zod-3 consumers — bump the dev dependency and teach the JSON-Schema derivation path to use zod 4's native converter — keeping hub validator-agnostic and portable.

**Architecture:** hub never imports zod statically; it validates through the Standard Schema v1 protocol. The only zod-aware code is `persisted-schemas/derive.ts`, which lazy-imports a converter. This plan adds a zod-4 detection heuristic and a native-`z.toJSONSchema()` branch (lazy `import('zod')`), leaving the existing zod-3 `zod-to-json-schema` branch intact as the fallback.

**Tech Stack:** TypeScript, Vitest, zod 4 (devDependency only), Standard Schema v1.

## Global Constraints

- `zod` stays a **devDependency** of hub — never promoted to a direct or peer dependency (copied from spec: "zod stays a devDependency; it is not promoted to a direct or peer dependency").
- **No static `import 'zod'`** anywhere in `packages/hub/src` — zod access is lazy/dynamic only (`await import('zod')`), like the existing `zod-to-json-schema` load.
- hub must remain portable: no `node:*` imports (enforced by `scripts/check-architecture.mjs`).
- Both zod 3 and zod 4 schemas must derive a JSON Schema; non-zod validators keep returning the stub envelope.
- No Claude attribution in commits (no `Co-Authored-By: Claude` / "Generated with Claude Code").
- Run `npm test -w @noy-db/hub` for the hub suite; the package uses Vitest.

---

### Task 1: Bump zod devDependency 3 → 4 and green the suite

**Files:**
- Modify: `packages/hub/package.json` (the `"zod": "^3.23.0"` line under `devDependencies`)
- Modify: `packages/cli/package.json` (the `"zod": "^3.23.0"` line under `devDependencies`)
- Test: existing hub + cli suites (no new test file)

**Interfaces:**
- Consumes: nothing.
- Produces: a workspace where `zod` resolves to 4.x; the hub test suite passes against zod 4. Later tasks rely on zod 4 being importable via `await import('zod')` in tests.

- [ ] **Step 1: Inspect current zod usage to confirm the stable-subset claim**

Run: `grep -rn "z\.\|from 'zod'\|from \"zod\"" packages/hub/src packages/hub/test packages/hub/__tests__ 2>/dev/null | grep -v node_modules | sort | uniq -c | sort -rn | head -40`
Expected: usages limited to the cross-major-stable subset (`z.object`, `z.string`, `z.number`, `z.enum`, `z.union`, `z.array`, `z.literal`, `.optional`, `.refine`, `.default`, `.parse`, `.safeParse`). Note any zod-3-only API (e.g. `z.string().nonempty()` removed in v4, `.merge()` semantics, `ZodError.format()` shape) — these are the only spots Step 4 may need to touch.

- [ ] **Step 2: Bump the devDependency in both packages**

In `packages/hub/package.json` change the `devDependencies` entry:
```json
"zod": "^4.0.0",
```
In `packages/cli/package.json` change the `devDependencies` entry:
```json
"zod": "^4.0.0",
```
Leave `zod-to-json-schema` exactly as-is (`devDependencies: "^3.25.2"`, `peerDependencies: "^3.25.0"`, `peerDependenciesMeta.optional: true`).

- [ ] **Step 3: Install and resolve**

Run: `npm install`
Then: `node -e "console.log(require('zod/package.json').version)"`
Expected: a `4.x.y` version string.

- [ ] **Step 4: Run the full hub + cli suites; fix any zod-3→4 fallout**

Run: `npm test -w @noy-db/hub`
Expected: PASS. If a test fails on a zod-3-only API found in Step 1, migrate that call to its zod-4 equivalent (e.g. `z.string().nonempty()` → `z.string().min(1)`; `err.format()` → `err.issues` / `z.treeifyError`). Do **not** change non-test source — hub `src/` does not import zod.
Run: `npm test -w @noy-db/cli`
Expected: PASS (cli uses zod for its own command schemas; apply the same migration if needed).

- [ ] **Step 5: Verify portability + architecture still hold**

Run: `node scripts/check-architecture.mjs`
Expected: PASS (no ceiling regressions; no new `node:*` imports).
Run: `grep -rn "from 'zod'\|from \"zod\"\|require('zod')" packages/hub/src` 
Expected: NO matches (hub src must not import zod — the bump is dev/test-only).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/package.json packages/cli/package.json package-lock.json
git commit -m "build(hub): bump zod devDependency to v4 (#482)"
```

---

### Task 2: zod-4 detection + native derivation branch

**Files:**
- Modify: `packages/hub/src/persisted-schemas/derive.ts`
- Test: `packages/hub/src/persisted-schemas/derive.test.ts` (create if absent; otherwise add to the existing test file — check with `ls packages/hub/src/persisted-schemas/`)

**Interfaces:**
- Consumes: `derivePersistedSchema(validator: unknown): Promise<PersistedSchemaEnvelope>` (existing), `PersistedSchemaKind` (existing union — verify it includes `'Zod'`, `'Unknown'`).
- Produces: zod-4 schemas now derive a real `jsonSchema` (kind `'Zod'`); zod-3 schemas unchanged; new exported predicate `isZod4Schema(value: unknown): boolean`.

- [ ] **Step 1: Empirically confirm the zod-4 schema shape and converter**

Run:
```bash
node -e "const z=require('zod'); const s=z.object({a:z.string()}); console.log('has _zod:', !!s._zod, '| has _def:', !!s._def, '| _def.typeName:', s?._def?.typeName); console.log('toJSONSchema type:', typeof z.toJSONSchema); console.log(JSON.stringify(z.toJSONSchema(s)));"
```
Expected: prints whether zod-4 instances carry `_zod` (the v4 internal namespace) and/or `_def`, confirms `z.toJSONSchema` is a function, and prints a valid JSON Schema. **Use the actual observed shape** to write the detection in Step 3 (if `_zod` is the discriminator, key on it; if v4 still exposes `_def.typeName` starting with something other than `Zod`, adjust accordingly). Record the observation in the test file as a comment.

- [ ] **Step 2: Write the failing tests**

In `packages/hub/src/persisted-schemas/derive.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { derivePersistedSchema, isZod4Schema, isZodSchema } from './derive.js'

describe('derivePersistedSchema — zod 4', () => {
  it('detects a zod-4 schema', () => {
    expect(isZod4Schema(z.object({ a: z.string() }))).toBe(true)
    expect(isZod4Schema({})).toBe(false)
    expect(isZod4Schema(null)).toBe(false)
  })

  it('derives a real JSON Schema from a zod-4 schema (kind=Zod)', async () => {
    const env = await derivePersistedSchema(z.object({ name: z.string(), age: z.number() }))
    expect(env.kind).toBe('Zod')
    expect(env.jsonSchema).not.toBeNull()
    expect(env.hash).not.toBeNull()
    // properties survive the conversion
    const props = (env.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['age', 'name'])
  })

  it('returns the stub envelope for a non-zod validator', async () => {
    const env = await derivePersistedSchema({ '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) } })
    expect(env.kind).toBe('Unknown')
    expect(env.jsonSchema).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w @noy-db/hub -- derive`
Expected: FAIL — `isZod4Schema` is not exported; the zod-4 derive test fails because the current `detectKind` keys on `_def.typeName.startsWith('Zod')` (zod-3 shape) and the converter is `zod-to-json-schema` (zod-3-only).

- [ ] **Step 4: Implement zod-4 detection + native branch**

In `packages/hub/src/persisted-schemas/derive.ts`, add the predicate (adjust the discriminator to the Step-1 observation) and a lazy native converter, and branch in `derivePersistedSchema`:

```ts
/**
 * Heuristic zod-4 detection. zod 4 moved schema internals to the `_zod`
 * namespace (vs zod 3's `_def.typeName`). Kept duck-typed so hub never
 * statically imports zod.
 */
export function isZod4Schema(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  return typeof (value as { _zod?: unknown })._zod === 'object'
    && (value as { _zod?: unknown })._zod !== null
}

/**
 * Lazy-import zod 4's native `toJSONSchema`. Returns the converter, or
 * throws a clear error if zod isn't installed. zod 4-only — zod 3 has no
 * native converter and uses {@link loadZodConverter} (`zod-to-json-schema`).
 */
async function loadZod4Converter(): Promise<(s: unknown) => object> {
  try {
    const mod = (await import('zod')) as { toJSONSchema?: (s: unknown) => object }
    if (!mod.toJSONSchema) throw new Error('zod.toJSONSchema export missing (need zod >= 4)')
    return mod.toJSONSchema
  } catch (err) {
    throw new Error(
      'deriving a JSON Schema from a zod-4 validator requires `zod` (>=4) to be importable. '
      + `Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
```

Update `derivePersistedSchema` so the `'Zod'` branch picks the converter by version:

```ts
export async function derivePersistedSchema(
  validator: unknown,
): Promise<PersistedSchemaEnvelope> {
  const kind = detectKind(validator)
  const derivedAt = new Date().toISOString()

  if (kind === 'Zod') {
    const convert = isZod4Schema(validator)
      ? await loadZod4Converter()
      : await loadZodConverter()
    const jsonSchema = convert(validator)
    const canonical = canonicalize(jsonSchema)
    const hash = await sha256Hex(new TextEncoder().encode(canonical))
    return { _noydb_schema: 1, kind, jsonSchema, hash, derivedAt }
  }

  return {
    _noydb_schema: 1,
    kind,
    jsonSchema: null,
    hash: null,
    reason: `derivation not yet supported for kind=${kind} (v0 supports Zod only)`,
    derivedAt,
  }
}
```

Update `detectKind`/`isZodSchema` so a zod-4 schema is also classified `'Zod'`:

```ts
function detectKind(validator: unknown): PersistedSchemaKind {
  if (isZodSchema(validator) || isZod4Schema(validator)) return 'Zod'
  return 'Unknown'
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @noy-db/hub -- derive`
Expected: PASS (all three new tests, plus any pre-existing derive tests).

- [ ] **Step 6: Confirm portability + no static zod import**

Run: `grep -rn "from 'zod'\|from \"zod\"" packages/hub/src`
Expected: NO matches (the new converter uses dynamic `await import('zod')`, not a static import).
Run: `node scripts/check-architecture.mjs`
Expected: PASS.

- [ ] **Step 7: Document zod-4 support in the subsystem doc**

In `packages/hub/src/persisted-schemas/derive.ts` top doc-comment, change the line "v0 supports Zod via `zod-to-json-schema` (optional peer-dep)" to note both majors: "Supports zod 3 (via the optional `zod-to-json-schema` peer-dep) and zod 4 (via its native `z.toJSONSchema()`); both are loaded lazily so hub never statically imports zod." If `docs/subsystems/` has a schema/introspection doc, add one sentence there stating hub accepts any Standard-Schema validator, with zod 3 or 4 both supported.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/persisted-schemas/derive.ts packages/hub/src/persisted-schemas/derive.test.ts docs
git commit -m "feat(hub): zod-4 native JSON-Schema derivation, kept agnostic + lazy (#482)"
```

---

## Self-Review

**Spec coverage (#482 portion):**
- devDep zod 3→4 bump → Task 1. ✓
- zod-version-aware `derivePersistedSchema` (native zod-4 toJSONSchema + zod-3 fallback) → Task 2. ✓
- "hub accepts any Standard-Schema validator; zod-4 read is a bonus" documentation → Task 2 Step 7. ✓
- No peer-dep change, no static zod import → Global Constraints + Task 1 Step 5 + Task 2 Step 6. ✓

**Placeholder scan:** none — all steps carry concrete code/commands. The single deliberate empirical step (Task 2 Step 1) verifies the zod-4 internal shape before writing the heuristic, with a concrete fallback instruction.

**Type consistency:** `isZod4Schema`, `loadZod4Converter`, `derivePersistedSchema`, `detectKind`, `PersistedSchemaEnvelope`, `PersistedSchemaKind` used consistently and match `derive.ts` as read.
