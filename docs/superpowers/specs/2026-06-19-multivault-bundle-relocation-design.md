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
  - `PublicEnvelope` (type) — **internal only** (`hub/src/meta/public-envelope/types.js`). This is the **one** primitive noy-db must newly expose.
  - byte helpers `readUint32BE` / `writeUint32BE` / `hasNoydbBundleMagic` — trivial; **klum brings its own** rather than have hub expose low-level byte utilities.

## Design

### Stays in noy-db (unchanged behavior)
Single-vault bundle (`bundle.ts`), byte-format primitives (`format.ts`), `extractPartition`, `decryptExtractedPartition`, `describeExtraction`, snapshots. noy-db's single-vault bundle format is byte-unchanged.

### noy-db sheds + exposes
1. **Expose** `PublicEnvelope` as a public type from `@noy-db/hub` (additive; the only new surface).
2. **Delete** `packages/hub/src/bundle/multi-bundle.ts` and its re-exports from `hub/src/index.ts` and `hub/src/bundle/index.ts`.
3. **Remove** the `multi-compartment-bundle` entry from `features.yaml` (package `@noy-db/hub`).

### klum-db receives
1. New module `klum-db/src/bundle/multi-bundle.ts` (dedicated `src/bundle/` directory — distinct concern from `src/interchange/`). It is the moved NDBM framing, with imports rebound to the published seam:
   - single-vault read/write + `WriteNoydbBundleOptions` from `@noy-db/hub/bundle`; `readNoydbBundlePublicEnvelope` + `PublicEnvelope` type from `@noy-db/hub`; `sha256Hex`/`generateULID`/`Vault` from `@noy-db/hub/kernel`.
   - klum-owned `uint32be` helpers (a ~10-line local utility) — the NDBM outer framing is klum's own format.
2. **Rewire** `src/interchange/extract-cross-vault.ts`: import `encodeMultiBundle` / `NOYDB_MULTI_BUNDLE_VERSION` / `MultiBundleManifest` / `CompartmentManifest` from the local `../bundle/multi-bundle.js`; keep `readNoydbBundleHeader` / `describeExtraction` / `ExtractionPreview` from `@noy-db/hub/bundle` and `generateULID` from `@noy-db/hub/kernel`.
3. **Export** the multivault bundle API from klum's public barrel (`src/index.ts`) so consumers reach it via `@klum-db/lobby`.
4. **Migrate the tests** for the NDBM bundle (codec round-trips, format-polymorphic manifest, overrun/dup-handle guards) into klum, running against the published `@noy-db`.

### Public-API outcome
`@noy-db/hub` no longer exports any multivault/NDBM symbol. Consumers wanting a multivault bundle import from `@klum-db/lobby`. noy-db's bundle surface is single-vault only.

## The publish-seam sequence (3-PR, no-gap)

The multivault bundle is never missing from *both* published packages, so klum is never broken mid-flight. (noy-db and klum-db version on **independent** `pre.N` lines now — `pre.N`/`pre.M` below do not need to align; noy-db is currently at `pre.24`, klum at `pre.26`.)

1. **noy-db PR-A** *(additive, non-breaking)*: expose `PublicEnvelope` type. **Keep** `multi-bundle.ts`. Merge → publish `@noy-db pre.N`.
2. **klum-db PR** : add `src/bundle/multi-bundle.ts` (consuming `pre.N`), rewire `extract-cross-vault`, export from barrel, migrate tests. Merge → publish `@klum-db/lobby` (its next `pre.M`).
3. **noy-db PR-B** *(breaking)*: delete `multi-bundle.ts` + its re-exports + the `features.yaml` entry. Merge → publish `@noy-db pre.N+1`.

After step 3, klum's `extract-cross-vault` already imports from its local module, so removing the hub copy breaks nothing. (Pre-1.0 this could collapse to 2 PRs with a brief gap; the no-gap version is preferred to keep the seam honest.)

## Testing & verification

- **noy-db PR-A:** `pnpm turbo build/typecheck/lint`, `validate:features`, `check:architecture` (Check 8 still green). Additive — no behavior change.
- **klum-db PR:** `pnpm test` (the migrated NDBM suite + existing 177 green) against published `@noy-db pre.N`; `pnpm build/typecheck/lint`.
- **noy-db PR-B:** full gate suite; confirm no dangling references to multivault symbols; `validate:features` passes with the entry removed; hub test count drops only by the migrated NDBM tests.

## Out of scope (separate specs in the boundary epic)
- **Workstream #2 — governance ceremonies:** custody (Deed/Custodian/Liberate), two-party withdrawal, managed transfer → klum façades over hub crypto. Security-sensitive.
- **Workstream #3 — tooling federation-awareness:** a vault-shape-agnostic inspect/meter contract in noy + klum-side group commands. Dependency-direction-sensitive (`no-outbound-klum-import`).
- Moving the single-vault bundle, `extractPartition`, or withdrawal-unilateral out of hub — these are vault primitives and stay.

## Risks / edge cases
- **`readNoydbBundleManifest` polymorphism:** it returns a 1-entry manifest for a single v1 bundle. After the move it lives in klum; any noy-db caller relying on it must use single-vault `readNoydbBundleHeader` instead. (Verified: no noy-db internal caller exists.)
- **Type-only vs runtime:** `PublicEnvelope` is a type; exposing it is erased at emit (no runtime cost, no bundle-size impact on hub).
- **Version skew:** klum's `multi-bundle.ts` pins behavior to the published `@noy-db` single-vault bundle format. The NDBM container embeds untouched v1 bundles (compose-don't-mutate), so a hub single-vault format bump remains backward-compatible by construction — but the klum NDBM tests run against the published hub to catch any drift at the seam.
