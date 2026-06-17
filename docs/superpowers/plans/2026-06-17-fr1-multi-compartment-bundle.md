# FR-1: Multi-compartment Bundle + pre-decrypt Manifest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let one `.noydb` container hold N vault compartments with a pre-decrypt manifest, by **composing** existing single-vault bundles inside a new outer container — without touching the v1 format.

**Architecture:** A multi-compartment bundle is a new **`NDBM`** container: a fixed prefix, an unencrypted **manifest** (the opt-in disclosure layer), then N standard `.noydb` v1 bundles concatenated. Each compartment is produced by the existing `writeNoydbBundle` and read by the existing `readNoydbBundle` — so the v1 format/validator is **untouched**, every compartment "loads independently" for free, and the strict inner minimum-disclosure headers stay strict while the outer manifest carries owner-curated, opt-in fields. (FR-1 epic #441; design spec `docs/superpowers/specs/2026-06-16-lobby-framework-design.md` §7–8.)

**Tech Stack:** TS strict, ESM `.js` specifiers, vitest. New code is self-contained in `@noy-db/hub` (`packages/hub/src/bundle/`); no `@klum-db` change (Lobby orchestration is FR-2).

**Design decisions (approved):**
- **Manifest disclosure = opt-in, layered.** Always: `handle`, `roleTag?`, `exportedAt`, `innerBytes`, `innerSha256`. Opt-in (writer chooses per compartment): `name`, `collections[{name,count}]`, `publicEnvelope`.
- **Scope = pure hub format.** No `Lobby.exportBundle` in FR-1.
- **Compose, don't mutate v1.** New `NDBM` outer container embeds untouched v1 `.noydb` bundles.

---

## Outer container layout (`NDBM`)

```
offset 0 : magic 'NDBM'            (4 bytes: 0x4e 0x44 0x42 0x4d)
offset 4 : multiFormatVersion = 1  (1 byte)
offset 5 : reserved = 0            (1 byte)
offset 6 : manifestLength uint32BE (4 bytes)
offset 10: manifest JSON (UTF-8, manifestLength bytes)
offset 10+manifestLength: inner v1 bundles concatenated, in manifest order,
                          each `compartments[i].innerBytes` long.
```
The manifest is the source of truth for framing: slice compartment `i` by summing prior `innerBytes`. Each inner slice is a complete, standard `.noydb` bundle.

---

## File structure

- **Create** `packages/hub/src/bundle/multi-bundle.ts` — constants, types, manifest validator, encode/decode framing, `writeMultiVaultBundle`, `readNoydbBundleManifest`, `readMultiVaultBundleCompartment`.
- **Create** `packages/hub/__tests__/multi-bundle.test.ts` — tests.
- **Modify** `packages/hub/src/bundle/index.ts` and `packages/hub/src/index.ts` — public exports.
- **Modify** `features.yaml` — register the capability (CI "Spec coverage" gate).

---

## Task 1 — Format module: constants, types, validator, framing codec (TDD)

**Files:** Create `packages/hub/src/bundle/multi-bundle.ts`; Create `packages/hub/__tests__/multi-bundle.test.ts`.

- [ ] **Step 1: Write the failing framing round-trip test** — `packages/hub/__tests__/multi-bundle.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import {
  NOYDB_MULTI_BUNDLE_MAGIC,
  encodeMultiBundle,
  decodeMultiBundle,
  type MultiBundleManifest,
} from '../src/bundle/multi-bundle.js'

describe('multi-bundle framing codec', () => {
  it('round-trips a manifest + inner byte blobs', () => {
    const inner0 = new Uint8Array([1, 2, 3, 4, 5])
    const inner1 = new Uint8Array([9, 8, 7])
    const manifest: MultiBundleManifest = {
      multiFormatVersion: 1,
      handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [
        { handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 5, innerSha256: 'a'.repeat(64), roleTag: 'shard' },
        { handle: '01HBBBBBBBBBBBBBBBBBBBBBBB', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 3, innerSha256: 'b'.repeat(64) },
      ],
    }
    const bytes = encodeMultiBundle(manifest, [inner0, inner1])
    expect(bytes.subarray(0, 4)).toEqual(NOYDB_MULTI_BUNDLE_MAGIC)
    const decoded = decodeMultiBundle(bytes)
    expect(decoded.manifest).toEqual(manifest)
    expect(decoded.inner[0]).toEqual(inner0)
    expect(decoded.inner[1]).toEqual(inner1)
  })

  it('rejects bytes without the NDBM magic', () => {
    expect(() => decodeMultiBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toThrow(/magic/i)
  })

  it('rejects a manifest whose innerBytes sum exceeds the body', () => {
    const m: MultiBundleManifest = {
      multiFormatVersion: 1, handle: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      compartments: [{ handle: '01HAAAAAAAAAAAAAAAAAAAAAAA', exportedAt: '2026-06-17T00:00:00.000Z', innerBytes: 999, innerSha256: 'a'.repeat(64) }],
    }
    const bytes = encodeMultiBundle(m, [new Uint8Array([1, 2, 3])])
    // tamper: truncate body so the declared innerBytes overruns
    expect(() => decodeMultiBundle(bytes.subarray(0, bytes.length - 1))).toThrow(/truncat|overrun|length/i)
  })
})
```

- [ ] **Step 2: Run → fail** (`pnpm --filter @noy-db/hub test -- multi-bundle`) — module missing.

- [ ] **Step 3: Implement the format module** — `packages/hub/src/bundle/multi-bundle.ts`:
```typescript
/**
 * Multi-compartment `.noydb` bundle (`NDBM`). A thin outer container
 * that embeds N standard single-vault `.noydb` bundles plus an
 * unencrypted, owner-curated **manifest**. The v1 single-vault format
 * is untouched; each compartment is a complete v1 bundle, produced by
 * `writeNoydbBundle` and read by `readNoydbBundle`.
 *
 * Layout: magic 'NDBM'(4) · version(1) · reserved(1) · manifestLen(4 BE)
 *         · manifest JSON · concat(inner v1 bundles, in manifest order).
 *
 * @packageDocumentation
 */
import type { Vault } from '../vault.js'
import type { PublicEnvelope } from '../meta/public-envelope/types.js'
import { sha256Hex } from '../crypto.js'
import { generateULID } from './ulid.js'
import { readUint32BE, writeUint32BE, hasNoydbBundleMagic } from './format.js'
import {
  writeNoydbBundle,
  readNoydbBundleHeader,
  readNoydbBundlePublicEnvelope,
  type WriteNoydbBundleOptions,
} from './bundle.js'

/** Magic bytes 'NDBM' — NOYDB Multi-compartment bundle. */
export const NOYDB_MULTI_BUNDLE_MAGIC = new Uint8Array([0x4e, 0x44, 0x42, 0x4d])
/** Fixed prefix: magic(4) + version(1) + reserved(1) + manifestLen(4). */
export const NOYDB_MULTI_BUNDLE_PREFIX_BYTES = 10
/** Current multi-bundle layout version. */
export const NOYDB_MULTI_BUNDLE_VERSION = 1

/** One compartment's entry in the pre-decrypt manifest. */
export interface CompartmentManifest {
  /** The inner v1 bundle's stable ULID handle. */
  readonly handle: string
  /** Owner-curated classification (e.g. 'shard', 'pool'). Opt-in. */
  readonly roleTag?: string
  /** ISO export timestamp. Always set by the writer; absent for a v1 bundle read as a 1-entry manifest. */
  readonly exportedAt?: string
  /** Compartment (vault) name. Opt-in disclosure. */
  readonly name?: string
  /** Collection names + record counts. Opt-in disclosure. */
  readonly collections?: readonly { readonly name: string; readonly count: number }[]
  /** Inner bundle's owner-curated public envelope, surfaced. Opt-in. */
  readonly publicEnvelope?: PublicEnvelope
  /** Byte length of the inner v1 bundle (drives framing). */
  readonly innerBytes: number
  /** SHA-256 (lowercase hex) of the inner v1 bundle bytes — pre-decrypt integrity. */
  readonly innerSha256: string
}

/** The unencrypted manifest of a multi-compartment bundle. */
export interface MultiBundleManifest {
  readonly multiFormatVersion: number
  /** Opaque ULID for the outer container. */
  readonly handle: string
  readonly compartments: readonly CompartmentManifest[]
}

/** Assemble the `NDBM` container from a manifest + inner bundle bytes (in manifest order). */
export function encodeMultiBundle(
  manifest: MultiBundleManifest,
  inner: readonly Uint8Array[],
): Uint8Array {
  if (manifest.compartments.length !== inner.length) {
    throw new Error(`multi-bundle: manifest has ${manifest.compartments.length} compartments but ${inner.length} inner bundles were provided.`)
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const bodyLen = inner.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(NOYDB_MULTI_BUNDLE_PREFIX_BYTES + manifestBytes.length + bodyLen)
  out.set(NOYDB_MULTI_BUNDLE_MAGIC, 0)
  out[4] = NOYDB_MULTI_BUNDLE_VERSION
  out[5] = 0
  writeUint32BE(out, 6, manifestBytes.length)
  out.set(manifestBytes, NOYDB_MULTI_BUNDLE_PREFIX_BYTES)
  let off = NOYDB_MULTI_BUNDLE_PREFIX_BYTES + manifestBytes.length
  for (const b of inner) { out.set(b, off); off += b.length }
  return out
}

function hasMultiMagic(bytes: Uint8Array): boolean {
  if (bytes.length < NOYDB_MULTI_BUNDLE_MAGIC.length) return false
  for (let i = 0; i < NOYDB_MULTI_BUNDLE_MAGIC.length; i++) if (bytes[i] !== NOYDB_MULTI_BUNDLE_MAGIC[i]) return false
  return true
}

function validateManifest(parsed: unknown): asserts parsed is MultiBundleManifest {
  if (parsed === null || typeof parsed !== 'object') throw new Error('multi-bundle manifest must be a JSON object.')
  const m = parsed as Record<string, unknown>
  if (m['multiFormatVersion'] !== NOYDB_MULTI_BUNDLE_VERSION) throw new Error(`multi-bundle manifest.multiFormatVersion must be ${NOYDB_MULTI_BUNDLE_VERSION}, got ${String(m['multiFormatVersion'])}.`)
  if (typeof m['handle'] !== 'string') throw new Error('multi-bundle manifest.handle must be a string.')
  if (!Array.isArray(m['compartments'])) throw new Error('multi-bundle manifest.compartments must be an array.')
  for (const c of m['compartments'] as unknown[]) {
    if (c === null || typeof c !== 'object') throw new Error('multi-bundle compartment must be an object.')
    const e = c as Record<string, unknown>
    if (typeof e['handle'] !== 'string') throw new Error('multi-bundle compartment.handle must be a string.')
    if (typeof e['innerBytes'] !== 'number' || !Number.isInteger(e['innerBytes']) || e['innerBytes'] < 0) throw new Error('multi-bundle compartment.innerBytes must be a non-negative integer.')
    if (typeof e['innerSha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(e['innerSha256'])) throw new Error('multi-bundle compartment.innerSha256 must be 64-char lowercase hex.')
  }
}

/** Parse the `NDBM` container into its manifest + raw inner bundle byte slices. */
export function decodeMultiBundle(bytes: Uint8Array): { manifest: MultiBundleManifest; inner: Uint8Array[] } {
  if (!hasMultiMagic(bytes)) throw new Error('not a NOYDB multi-bundle: missing NDBM magic.')
  if (bytes.length < NOYDB_MULTI_BUNDLE_PREFIX_BYTES) throw new Error('multi-bundle truncated: shorter than the fixed prefix.')
  if (bytes[4] !== NOYDB_MULTI_BUNDLE_VERSION) throw new Error(`unsupported multi-bundle version ${String(bytes[4])}.`)
  const manifestLen = readUint32BE(bytes, 6)
  const manifestEnd = NOYDB_MULTI_BUNDLE_PREFIX_BYTES + manifestLen
  if (manifestEnd > bytes.length) throw new Error('multi-bundle truncated: manifest length overruns the buffer.')
  const manifestJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(NOYDB_MULTI_BUNDLE_PREFIX_BYTES, manifestEnd))
  let parsed: unknown
  try { parsed = JSON.parse(manifestJson) } catch (err) { throw new Error(`multi-bundle manifest is not valid JSON: ${(err as Error).message}`) }
  validateManifest(parsed)
  const inner: Uint8Array[] = []
  let off = manifestEnd
  for (const c of parsed.compartments) {
    const end = off + c.innerBytes
    if (end > bytes.length) throw new Error(`multi-bundle truncated: compartment "${c.handle}" innerBytes overruns the buffer.`)
    inner.push(bytes.subarray(off, end))
    off = end
  }
  return { manifest: parsed, inner }
}
```
(If `WriteNoydbBundleOptions`/`readNoydbBundlePublicEnvelope` are not exported from `./bundle.js`, they are — confirmed in `bundle/index.ts`. Keep the `validateManifest` type-narrowing so `parsed.compartments` is typed in `decodeMultiBundle`.)

- [ ] **Step 4: Run → pass** (`pnpm --filter @noy-db/hub test -- multi-bundle`). Then `pnpm --filter @noy-db/hub typecheck`.

- [ ] **Step 5: Commit** — `git add packages/hub/src/bundle/multi-bundle.ts packages/hub/__tests__/multi-bundle.test.ts && git commit -m "feat(hub): multi-bundle NDBM framing codec + manifest types"`

---

## Task 2 — `writeMultiVaultBundle` (compose v1 bundles) (TDD)

**Files:** Modify `packages/hub/src/bundle/multi-bundle.ts`; Modify the test.

- [ ] **Step 1: Append the failing writer test.** Follow `packages/hub/__tests__/bundle.test.ts` for the in-memory vault setup (createNoydb + store + `vault.collection(...).put(...)`). Create TWO vaults with a couple of records each, then:
```typescript
import { writeMultiVaultBundle, readNoydbBundleManifest } from '../src/bundle/multi-bundle.js'
// ... in a test, with two opened vaults `a` and `b` holding data:
const bytes = await writeMultiVaultBundle([
  { vault: a, roleTag: 'shard', exportedAt: '2026-06-17T00:00:00.000Z', disclose: { name: true, collections: true } },
  { vault: b, roleTag: 'pool' },
])
const manifest = await readNoydbBundleManifest(bytes)
expect(manifest).toHaveLength(2)
expect(manifest[0]!.roleTag).toBe('shard')
expect(manifest[0]!.name).toBe(a.name)            // disclosed
expect(manifest[0]!.collections?.length).toBeGreaterThan(0)  // disclosed
expect(manifest[1]!.roleTag).toBe('pool')
expect(manifest[1]!.name).toBeUndefined()         // not disclosed
expect(manifest[1]!.collections).toBeUndefined()  // not disclosed
expect(manifest[0]!.innerSha256).toMatch(/^[0-9a-f]{64}$/)
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `writeMultiVaultBundle`** — append to `multi-bundle.ts`:
```typescript
/** Per-compartment input to {@link writeMultiVaultBundle}. */
export interface MultiVaultCompartmentInput {
  readonly vault: Vault
  /** Owner-curated classification surfaced in the manifest (e.g. 'shard', 'pool'). */
  readonly roleTag?: string
  /** ISO timestamp for the manifest; defaults to now. */
  readonly exportedAt?: string
  /** Opt-in pre-decrypt disclosure for this compartment. */
  readonly disclose?: {
    /** `true` → use `vault.name`; a string → that explicit name. */
    readonly name?: boolean | string
    /** `true` → include collection names + record counts. */
    readonly collections?: boolean
    /** `true` → surface the inner bundle's public envelope into the manifest. */
    readonly publicEnvelope?: boolean
  }
  /** Options forwarded to `writeNoydbBundle` for this compartment's inner bundle. */
  readonly bundleOptions?: WriteNoydbBundleOptions
}

/** Write N vaults into one `NDBM` multi-compartment bundle. */
export async function writeMultiVaultBundle(
  compartments: readonly MultiVaultCompartmentInput[],
  opts: { readonly handle?: string } = {},
): Promise<Uint8Array> {
  if (compartments.length === 0) throw new Error('writeMultiVaultBundle: at least one compartment is required.')
  const inner: Uint8Array[] = []
  const entries: CompartmentManifest[] = []
  for (const c of compartments) {
    const innerBytes = await writeNoydbBundle(c.vault, c.bundleOptions ?? {})
    const header = readNoydbBundleHeader(innerBytes)
    const entry: {
      -readonly [K in keyof CompartmentManifest]: CompartmentManifest[K]
    } = {
      handle: header.handle,
      exportedAt: c.exportedAt ?? new Date().toISOString(),
      innerBytes: innerBytes.length,
      innerSha256: await sha256Hex(innerBytes),
    }
    if (c.roleTag !== undefined) entry.roleTag = c.roleTag
    if (c.disclose?.name !== undefined && c.disclose.name !== false) {
      entry.name = c.disclose.name === true ? c.vault.name : c.disclose.name
    }
    if (c.disclose?.collections === true) {
      const names = await c.vault.collections()
      entry.collections = await Promise.all(
        names.map(async (n) => ({ name: n, count: await c.vault.collection(n).count() })),
      )
    }
    if (c.disclose?.publicEnvelope === true) {
      const env = readNoydbBundlePublicEnvelope(innerBytes)
      if (env !== undefined) entry.publicEnvelope = env
    }
    inner.push(innerBytes)
    entries.push(entry)
  }
  const manifest: MultiBundleManifest = {
    multiFormatVersion: NOYDB_MULTI_BUNDLE_VERSION,
    handle: opts.handle ?? generateULID(),
    compartments: entries,
  }
  return encodeMultiBundle(manifest, inner)
}
```
(Confirm `vault.collection(name)` + `.count()` and `vault.collections(): Promise<string[]>` against `vault.ts` — verified present. If `count()` needs args or differs, match the real signature.)

- [ ] **Step 4: Run → pass; typecheck.**

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): writeMultiVaultBundle composes v1 bundles + opt-in manifest"`

---

## Task 3 — Readers: `readNoydbBundleManifest` + `readMultiVaultBundleCompartment` (incl. v1 back-compat) (TDD)

**Files:** Modify `packages/hub/src/bundle/multi-bundle.ts`; Modify the test.

- [ ] **Step 1: Append failing reader tests:**
```typescript
import { readMultiVaultBundleCompartment } from '../src/bundle/multi-bundle.js'
import { readNoydbBundle, writeNoydbBundle } from '../src/bundle/bundle.js'

it('each compartment loads independently via readNoydbBundle', async () => {
  const bytes = await writeMultiVaultBundle([{ vault: a }, { vault: b }])
  const manifest = await readNoydbBundleManifest(bytes)
  for (const c of manifest) {
    const innerBytes = readMultiVaultBundleCompartment(bytes, c.handle)
    const verifySha = await import('../src/crypto.js').then(m => m.sha256Hex(innerBytes))
    expect(verifySha).toBe(c.innerSha256)
    const read = await readNoydbBundle(innerBytes)   // loads independently
    expect(read.dumpJson.length).toBeGreaterThan(0)
  }
})

it('reads a single v1 bundle as a 1-entry manifest (back-compat)', async () => {
  const v1 = await writeNoydbBundle(a)
  const manifest = await readNoydbBundleManifest(v1)
  expect(manifest).toHaveLength(1)
  expect(manifest[0]!.handle).toBe(readNoydbBundleHeader(v1).handle)
  // the whole v1 bundle IS the only compartment:
  expect(readMultiVaultBundleCompartment(v1, manifest[0]!.handle)).toEqual(v1)
})
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement the readers** — append to `multi-bundle.ts`:
```typescript
/**
 * Read the pre-decrypt manifest of a bundle WITHOUT decrypting any
 * compartment. Accepts a multi-compartment `NDBM` bundle (returns its
 * N entries) OR a single v1 `NDB1` bundle (returns a 1-entry manifest,
 * for uniform handling). Throws on anything else.
 */
export async function readNoydbBundleManifest(bytes: Uint8Array): Promise<CompartmentManifest[]> {
  if (hasMultiMagic(bytes)) return [...decodeMultiBundle(bytes).manifest.compartments]
  if (hasNoydbBundleMagic(bytes)) {
    const header = readNoydbBundleHeader(bytes)
    const env = readNoydbBundlePublicEnvelope(bytes)
    const entry: { -readonly [K in keyof CompartmentManifest]: CompartmentManifest[K] } = {
      handle: header.handle,
      innerBytes: bytes.length,
      innerSha256: await sha256Hex(bytes),
    }
    if (env !== undefined) entry.publicEnvelope = env
    return [entry]
  }
  throw new Error('readNoydbBundleManifest: not a NOYDB bundle (no NDB1 or NDBM magic).')
}

/**
 * Extract one compartment's inner v1 `.noydb` bundle bytes (verified
 * against its manifest `innerSha256`), ready to pass to `readNoydbBundle`.
 * `selector` is a compartment `handle` or a zero-based index. For a
 * single v1 bundle, the bundle itself is the only compartment.
 */
export function readMultiVaultBundleCompartment(bytes: Uint8Array, selector: string | number): Uint8Array {
  if (hasNoydbBundleMagic(bytes) && !hasMultiMagic(bytes)) {
    const header = readNoydbBundleHeader(bytes)
    if (selector === 0 || selector === header.handle) return bytes
    throw new Error(`readMultiVaultBundleCompartment: single v1 bundle has only compartment "${header.handle}".`)
  }
  const { manifest, inner } = decodeMultiBundle(bytes)
  const idx = typeof selector === 'number'
    ? selector
    : manifest.compartments.findIndex((c) => c.handle === selector)
  if (idx < 0 || idx >= inner.length) throw new Error(`readMultiVaultBundleCompartment: no compartment ${typeof selector === 'number' ? `at index ${selector}` : `"${selector}"`}.`)
  return inner[idx]!
}
```
(`readNoydbBundleManifest` is async only because the v1-compat branch hashes the whole bundle; the NDBM branch is sync-fast. That's fine.)

- [ ] **Step 4: Run → pass; typecheck.**

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): readNoydbBundleManifest + readMultiVaultBundleCompartment (v1 back-compat)"`

---

## Task 4 — Backward-compat + disclosure-default assertions (TDD)

**Files:** Modify the test only.

- [ ] **Step 1: Add assertions** proving the v1 path is untouched and the default manifest is minimal:
```typescript
it('single-vault writeNoydbBundle is byte-unaffected by this feature', async () => {
  // Two writes of the same vault content produce stable handles (existing v1 guarantee).
  const x = await writeNoydbBundle(a)
  expect(readNoydbBundleHeader(x).formatVersion).toBe(1) // still v1; NDB1, not NDBM
  expect(x.subarray(0, 4)).not.toEqual(NOYDB_MULTI_BUNDLE_MAGIC)
})

it('default manifest discloses only handle/roleTag/exportedAt (+ integrity), not name/collections', async () => {
  const bytes = await writeMultiVaultBundle([{ vault: a, roleTag: 'shard' }])
  const [c] = await readNoydbBundleManifest(bytes)
  expect(c!.handle).toBeDefined()
  expect(c!.exportedAt).toBeDefined()
  expect(c!.roleTag).toBe('shard')
  expect(c!.name).toBeUndefined()
  expect(c!.collections).toBeUndefined()
  expect(c!.publicEnvelope).toBeUndefined()
})
```

- [ ] **Step 2: Run → pass** (no impl change expected; if a fails, fix the impl from Task 2/3). Then run the FULL hub suite: `pnpm --filter @noy-db/hub test` — confirm the existing bundle tests are all still green (v1 untouched).

- [ ] **Step 3: Commit** — `git commit -am "test(hub): multi-bundle back-compat + default-disclosure assertions"`

---

## Task 5 — Public exports + features.yaml + full verification

**Files:** Modify `packages/hub/src/bundle/index.ts`, `packages/hub/src/index.ts`, `features.yaml`.

- [ ] **Step 1: Export from `packages/hub/src/bundle/index.ts`** — add after the existing bundle exports:
```typescript
export {
  writeMultiVaultBundle,
  readNoydbBundleManifest,
  readMultiVaultBundleCompartment,
  encodeMultiBundle,
  decodeMultiBundle,
  NOYDB_MULTI_BUNDLE_MAGIC,
  NOYDB_MULTI_BUNDLE_PREFIX_BYTES,
  NOYDB_MULTI_BUNDLE_VERSION,
} from './multi-bundle.js'
export type {
  CompartmentManifest,
  MultiBundleManifest,
  MultiVaultCompartmentInput,
} from './multi-bundle.js'
```

- [ ] **Step 2: Re-export the high-level API from `packages/hub/src/index.ts`** — next to the existing `writeNoydbBundle`/`readNoydbBundle` exports, add:
```typescript
export { writeMultiVaultBundle, readNoydbBundleManifest, readMultiVaultBundleCompartment } from './bundle/multi-bundle.js'
export type { CompartmentManifest, MultiBundleManifest, MultiVaultCompartmentInput } from './bundle/multi-bundle.js'
```

- [ ] **Step 3: Register in `features.yaml`** — open `features.yaml`, find how an existing bundle feature is declared (e.g. the entry for `writeNoydbBundle`/extraction), and add a sibling entry for the multi-compartment bundle (id like `multi-compartment-bundle`), pointing at the artefact (`packages/hub/src/bundle/multi-bundle.ts`) and the spec (`docs/superpowers/specs/2026-06-16-lobby-framework-design.md`, FR-1). Match the schema of neighbouring entries exactly. (This satisfies the CI "Spec coverage" gate — `node scripts/validate-features.mjs` must pass.)

- [ ] **Step 4: Full verification:**
```bash
pnpm --filter @noy-db/hub build
node --input-type=module -e "import('@noy-db/hub').then(m=>{ if(typeof m.writeMultiVaultBundle!=='function'||typeof m.readNoydbBundleManifest!=='function') throw new Error('exports missing'); console.log('exports OK') })"
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub typecheck
pnpm validate:features    # or: node scripts/validate-features.mjs
pnpm check:architecture
pnpm --filter @noy-db/hub bundle-check   # canaries must stay ✓; multi-bundle is a new module, not in the main entry's hot path
```
Expected: all green (bundle-check size may show the known stale-baseline drift — judge by canaries).

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): export multi-compartment bundle API + register in features.yaml"`

---

## Self-Review

**1. Spec coverage (issue #441 acceptance):**
- "round-trip an N-compartment bundle; each compartment loads independently" → Task 1 framing round-trip + Task 3 `readMultiVaultBundleCompartment` → `readNoydbBundle` per compartment.
- "manifest enumerates all compartments + public envelopes pre-decrypt" → Task 2/3 `readNoydbBundleManifest` (no decryption; `publicEnvelope` opt-in surfaced).
- "single-vault `writeNoydbBundle(vault)` stays backward-compatible" → Task 4 (v1 untouched; distinct `NDBM` magic; v1 reads as 1-entry manifest).
- Approved decisions: opt-in layered disclosure (Task 2 `disclose`), pure hub scope (no klum change).

**2. Placeholder scan:** every step has concrete code/commands. The two confirm-the-API notes (`vault.collections()`/`count()`, and `WriteNoydbBundleOptions` export) are verified-present, not guesses.

**3. Type/name consistency:** `writeMultiVaultBundle` / `readNoydbBundleManifest` / `readMultiVaultBundleCompartment` / `encodeMultiBundle` / `decodeMultiBundle` / `CompartmentManifest` / `MultiBundleManifest` / `MultiVaultCompartmentInput` consistent across tasks and both export sites. `NOYDB_MULTI_BUNDLE_*` constants consistent.

**4. Risk notes:** v1 format/validator deliberately untouched (compose, don't mutate); distinct `NDBM` magic makes v1 readers fail-closed; manifest integrity via per-compartment `innerSha256`; `exportedAt` is the only always-on timestamp and lives solely in the opt-in outer manifest (the strict inner v1 headers remain timestamp-free).
