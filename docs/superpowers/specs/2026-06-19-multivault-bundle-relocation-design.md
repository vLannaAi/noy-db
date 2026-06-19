# Multivault bundle relocation → @klum-db/lobby — design

**Status:** design (approved 2026-06-19) — ready for implementation plan
**Repos:** `vLannaAi/noy-db` (sheds + exposes) and `vLannaAi/klum-db` (receives). Cross-repo change across the published-package seam.
**Scope:** Workstream #1 of the "orchestration → klum-db" boundary epic. Workstreams #2 (governance ceremonies: custody / two-party withdrawal / transfer) and #3 (tooling federation-awareness: CLI / meter / dev tools) are **out of scope** here — separate specs.

## Goal

Relocate the **multi-compartment (multivault) NDBM bundle** from `@noy-db/hub` to `@klum-db/lobby`, leaving noy-db as the pure single-vault library. The single-vault `.noydb` bundle and all crypto/serialization primitives stay in hub.

## The boundary principle (why this moves)

A capability belongs to **klum-db** if it coordinates across a boundary — multiple vaults, stores, parties, or ownership/lifecycle states. It belongs to **noy-db** if it is contained within one vault's own data, crypto, and consistency.

The NDBM multivault bundle is **pure composition**: it frames N independent single-vault bundles into one container (`multi-bundle.ts` touches no crypto — it imports only `sha256Hex`, `generateULID`, byte-format helpers, and the single-vault bundle read/write functions). It crosses the vault boundary (N vaults in one container), so it is klum's. The single-vault bundle it composes does touch the vault's serialization, so it stays in hub. **Move the composition; keep the primitive.**

## Current state (verified 2026-06-19)

- `multi-bundle.ts` lives at `packages/hub/src/bundle/multi-bundle.ts`. It exports: `encodeMultiBundle`, `decodeMultiBundle`, `writeMultiVaultBundle`, `readNoydbBundleManifest` (format-polymorphic: NDBM → N entries, single v1 → 1 entry), `readMultiVaultBundleCompartment`, types `CompartmentManifest` / `MultiBundleManifest` / `MultiVaultCompartmentInput`, and constants `NOYDB_MULTI_BUNDLE_MAGIC` / `_PREFIX_BYTES` / `_VERSION`.
- **No noy-db code consumes it internally** — the only references are re-exports in `hub/src/index.ts` and `hub/src/bundle/index.ts`.
- **The only real consumer is klum** — `klum-db/src/interchange/extract-cross-vault.ts` imports `encodeMultiBundle`, `NOYDB_MULTI_BUNDLE_VERSION`, `MultiBundleManifest`, `CompartmentManifest` from `@noy-db/hub/bundle` (alongside single-vault `readNoydbBundleHeader`, `describeExtraction`, `ExtractionPreview`, and kernel `generateULID`).
- What the NDBM framing needs from hub, and where it already lives:
  - `writeNoydbBundle`, `readNoydbBundleHeader`, `WriteNoydbBundleOptions` — already on `@noy-db/hub/bundle`. ✓
  - `readNoydbBundlePublicEnvelope` — already on `@noy-db/hub` (root). ✓
  - `sha256Hex`, `generateULID`, `Vault` (type) — already on `@noy-db/hub/kernel`. ✓
  - `PublicEnvelope` (type) — **already public** on the `@noy-db/hub` root (`index.ts:528`). No change needed.
  - `hasNoydbBundleMagic` (predicate) — **ALREADY public** (`hub/src/index.ts:365`, re-exported from `bundle/format.ts`) and **already in the published `@noy-db/hub@0.2.0-pre.24`** (runtime-verified from klum's installed dep, 2026-06-20). klum's relocated NDBM reader consumes it directly. **No new noy-db surface is required — the originally-planned "PR-A expose" step is ELIMINATED.**
  - byte helpers `readUint32BE` / `writeUint32BE` — trivial; **klum brings its own** rather than have hub expose low-level byte utilities.

## Design

### Stays in noy-db (unchanged behavior)
Single-vault bundle (`bundle.ts`), byte-format primitives (`format.ts`), `extractPartition`, `decryptExtractedPartition`, `describeExtraction`, snapshots. noy-db's single-vault bundle format is byte-unchanged.

### noy-db sheds
**Nothing to expose** — `hasNoydbBundleMagic` + `PublicEnvelope` are already public and already published in `pre.24`. noy-db's only work is the removal:
1. **Delete** `packages/hub/src/bundle/multi-bundle.ts` and its re-exports from `hub/src/index.ts` and `hub/src/bundle/index.ts`.
2. **Remove** the `multi-compartment-bundle` entry from `features.yaml` (package `@noy-db/hub`).
3. **Add** a guard test (`bundle-magic-export.test.ts`) asserting `hasNoydbBundleMagic` stays publicly exported — klum now depends on it across the seam. (This is the salvaged test from the eliminated PR-A.)

### klum-db receives
1. New module `klum-db/src/bundle/multi-bundle.ts` (dedicated `src/bundle/` directory — distinct concern from `src/interchange/`). It is the moved NDBM framing, with imports rebound to the published seam:
   - single-vault read/write + `WriteNoydbBundleOptions` from `@noy-db/hub/bundle`; `readNoydbBundlePublicEnvelope` + `PublicEnvelope` type from `@noy-db/hub`; `sha256Hex`/`generateULID`/`Vault` from `@noy-db/hub/kernel`.
   - klum-owned `uint32be` helpers (a ~10-line local utility) — the NDBM outer framing is klum's own format.
2. **Rewire** `src/interchange/extract-cross-vault.ts`: import `encodeMultiBundle` / `NOYDB_MULTI_BUNDLE_VERSION` / `MultiBundleManifest` / `CompartmentManifest` from the local `../bundle/multi-bundle.js`; keep `readNoydbBundleHeader` / `describeExtraction` / `ExtractionPreview` from `@noy-db/hub/bundle` and `generateULID` from `@noy-db/hub/kernel`.
3. **Export** the multivault bundle API from klum's public barrel (`src/index.ts`) so consumers reach it via `@klum-db/lobby`.
4. **Migrate the tests** for the NDBM bundle (codec round-trips, format-polymorphic manifest, overrun/dup-handle guards) into klum, running against the published `@noy-db`.

### Public-API outcome
`@noy-db/hub` no longer exports any multivault/NDBM symbol. Consumers wanting a multivault bundle import from `@klum-db/lobby`. noy-db's bundle surface is single-vault only.

## The publish-seam sequence (2-PR, no-gap)

**PR-A is eliminated** — the primitives are already public and published in `pre.24`, so klum's work is unblocked immediately. The multivault bundle is never missing from *both* published packages, so klum is never broken mid-flight. (noy-db and klum-db version on **independent** `pre.N` lines; noy-db is at `pre.24`, klum at `pre.26`.)

1. **klum-db PR** *(unblocked now)*: add `src/bundle/multi-bundle.ts` (consuming the already-published `@noy-db@pre.24`), rewire `extract-cross-vault`, export from barrel, migrate tests. Merge → publish `@klum-db/lobby` (its next `pre.M`).
2. **noy-db PR** *(breaking)*: delete `multi-bundle.ts` + its re-exports + the `features.yaml` entry; add the `hasNoydbBundleMagic` guard test. Merge → publish `@noy-db pre.N`.

After step 2, klum's `extract-cross-vault` already imports from its local module and the published `@klum-db/lobby` owns the bundle, so removing the hub copy breaks nothing. The bundle stays in published `@noy-db@pre.24` until klum publishes its own in step 1 — no gap.

## Testing & verification

- **klum-db PR:** `pnpm test` (the migrated NDBM suite + existing 177 green) against the published `@noy-db@pre.24`; `pnpm build/typecheck/lint`.
- **noy-db PR:** full gate suite; the `hasNoydbBundleMagic` guard test passes; confirm no dangling references to multivault symbols; `validate:features` passes with the entry removed; hub test count drops only by the removed NDBM tests (net of the added guard test).

## Out of scope (separate specs in the boundary epic)
- **Workstream #2 — governance ceremonies:** custody (Deed/Custodian/Liberate), two-party withdrawal, managed transfer → klum façades over hub crypto. Security-sensitive.
- **Workstream #3 — tooling federation-awareness:** a vault-shape-agnostic inspect/meter contract in noy + klum-side group commands. Dependency-direction-sensitive (`no-outbound-klum-import`).
- Moving the single-vault bundle, `extractPartition`, or withdrawal-unilateral out of hub — these are vault primitives and stay.

## Risks / edge cases
- **`readNoydbBundleManifest` polymorphism:** it returns a 1-entry manifest for a single v1 bundle. After the move it lives in klum; any noy-db caller relying on it must use single-vault `readNoydbBundleHeader` instead. (Verified: no noy-db internal caller exists.)
- **Type-only vs runtime:** `PublicEnvelope` is a type; exposing it is erased at emit (no runtime cost, no bundle-size impact on hub).
- **Version skew:** klum's `multi-bundle.ts` pins behavior to the published `@noy-db` single-vault bundle format. The NDBM container embeds untouched v1 bundles (compose-don't-mutate), so a hub single-vault format bump remains backward-compatible by construction — but the klum NDBM tests run against the published hub to catch any drift at the seam.
