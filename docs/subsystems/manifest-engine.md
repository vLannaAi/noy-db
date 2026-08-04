# Manifest engine — the schema manifest + `open()` read path

The P0 core of the manifest-set roadmap (#941): pods gain a set of five specialized, versioned, encrypted manifests — schema / behavior / storage / access / app — under the invariant *"a pod always opens the same way, everywhere; what varies is only where its cargo is."* This issue builds the **manifest engine + the schema manifest + the `open()` read path**; it sits on top of the header/signature layer (#942/#943) and is a consumer of the field-id/generation work (#946).

## The reserved `_manifest` collection

`MANIFEST_COLLECTION` (`'_manifest'`, `with-shape/manifest/reserved-collections.ts`) is a single reserved collection, gated the same way `_schemas`/`_keyring`/etc. are: `vault.collection('_manifest')` is refused, even for the owner (`isManifestReservedCollection`). Records inside it are keyed by manifest *kind*, not one collection per kind — today only `schema` (record id `'schema'`, `MANIFEST_SCHEMA_RECORD_ID`) exists. `behavior` / `storage` / `access` / `app` are reserved record ids with no writer yet — anticipated, not built (P1: storage manifest + sync profiles + connection-pod URL open; P2: access + app manifests; P3: behavior manifest, deliberately demoted — keyring roles cover thin-client safety short-term). Being reserved, `_manifest` travels in a pod dump like every other internal collection (`with-pod/backup.ts`'s reserved-collection list carries both `_schemas` and `_manifest`).

## The schema manifest is an INDEX, not a copy

`SchemaManifest` (`with-shape/manifest/types.ts`) is a pod-wide record — one per pod — but it never inlines the JSON Schema bodies:

```ts
interface SchemaManifest {
  readonly v: 1
  readonly kind: 'schema'
  readonly generation: number                          // fence generation as of derivation
  readonly collections: Record<string, SchemaManifestEntry>
  readonly aggregateHash: string                        // sha256Hex(canonicalJson(collections))
}

interface SchemaManifestEntry {
  readonly generation: number       // this collection's own schema-fence generation
  readonly contentHash: string      // sha256 of the collection's canonicalised JSON Schema
  readonly fieldIds?: Record<string, string>   // stable field ids (#946), keyed by current name
}
```

The JSON Schema body stays the source of truth at `_schemas/<collection>`, encrypted under **that collection's own DEK** (`with-shape/persisted-schemas`). This is deliberate: inlining every collection's full schema into one pod-wide manifest record would either leak a collection's schema to a principal scoped to a different collection, or force the manifest onto a shared DEK it has no business holding. The index (hash + generation + field ids, metadata rather than bodies) preserves per-collection DEK isolation while still giving one place to answer "what schema generation is this pod at, and does collection X's stored schema match its declared content hash." The `_manifest` collection itself has its own DEK, at the same encryption grain as `_schemas`.

`aggregateHash` binds the whole per-collection index: `sha256Hex(canonicalJson(collections))`. Canonical JSON sorts object keys at every depth, so the hash is independent of the map's key insertion order — any change to any collection's entry (new generation, changed hash, added/renamed field id) changes `aggregateHash` too.

## Derived cache vs. strict-CAS direct edit

Two different write disciplines apply to `_manifest/schema`, and the distinction matters:

- **`deriveSchemaManifest(store, vault, getDEK)`** (`with-shape/manifest/derive.ts`) is a pure projection: read the fence generation + every `_schemas/<collection>` envelope, project into a fresh `SchemaManifest`. Re-running it against the same stored state always produces the same manifest — that's what makes round-trip identity (dump → restore → re-derive matches the original) hold for free, with no restore-side special casing.
- **`writeSchemaManifest(store, vault, manifest, expectedVersion, getDEK)`** (`with-shape/manifest/writer.ts`) is a **strict-CAS refuse-not-retry** writer: `expectedVersion` must match the stored envelope's `_v` or the write throws `ManifestConflictError` — this is the *only* writer in the hub that behaves this way; every other reserved-collection writer (persisted-schemas, classified/satellite markers) retries on conflict. This is deliberate divergence from data's tie-advance resolution: two concurrent *direct* edits to the manifest must be refused and surfaced, never silently merged, because a manifest write encodes a specific point-in-time claim about the pod's schema generation/content-hash set. A caller that lost the race must re-derive against the fresh state and decide what to do, not have a stale write quietly re-applied on top of someone else's.

`syncSchemaManifest` (`with-shape/manifest/sync.ts`) is the glue between the two: it's called from `persistSchemaIfNeeded` right after a `_schemas/<collection>` write succeeds, and it is **not** a direct edit — it's a re-derivation triggered as a side effect of a write that already landed. That's why it's allowed to retry (unlike the writer it calls).

### The converging recheck loop

When N collections are declared together in one `openVault()` call, their `persistSchemaIfNeeded` calls run **concurrently** — each one's `_schemas/<collection>` write lands independently and each then calls `syncSchemaManifest`. A single derive-then-write with no feedback loop is not enough: a call whose derive snapshot ran before a sibling's `_schemas` write landed would persist a manifest permanently missing that sibling (nothing re-triggers it) — this was a real bug, reproduced with zero shared state purely from concurrent `_schemas` writes racing the derive snapshot. `syncSchemaManifest` therefore loops (bounded by `MAX_SYNC_ATTEMPTS = 16`):

1. Derive fresh, compare to what's persisted. Already converged → done, no write, no audit.
2. Write via strict-CAS. `ManifestConflictError` (another writer moved the manifest first) → loop: re-derive against the new state and retry, exactly like a normal optimistic-CAS retry.
3. On a successful write, derive **once more**. If a sibling's write landed while deriving/writing, loop again to catch it up. If the re-derive matches what was just written, this was the last writer and the manifest is provably converged — return.

Whichever collection's `_schemas` write is the last to land (in real wall-clock order — there's always exactly one, though no single caller knows which in advance) ends up running a sync whose derive sees every sibling's write already committed, and whose recheck-after-write confirms nothing moved further. That converges the manifest deterministically regardless of interleaving.

**Cap-exhaustion behavior.** If attempts are exhausted under pathological contention, the loop stops — leaving the last successful write in place — and emits `console.warn('[noy-db] schema-manifest sync did not converge after 16 attempts; …')` rather than failing silently. The manifest is a derivable cache, not a correctness invariant: a later schema write or `open()`'s re-derive still converges it. But a silent give-up on a completeness invariant is exactly what hid the original concurrent-declare race, so the cap-exhaustion path is observable rather than invisible. Any error *other* than `ManifestConflictError` (store failure, DEK resolution failure, etc.) is never swallowed — it propagates immediately.

## Ledger audit

Schema-generation transitions were not ledger-audited anywhere before this: neither the `_schemas/<collection>` write in `register.ts` nor the fence bump in `schema-update/fence-controller.ts#runCutover`. `syncSchemaManifest` is the first ledger-audited signal for a schema change — every manifest write that actually happens (the derived manifest differed from what's stored) appends an `op: 'migration'` ledger entry via the optional `getLedgerOrNull` callback (absent/no-op when the history strategy isn't opted in, matching every other optional-ledger call site). No audit fires on the no-op path (derived manifest unchanged) or on a swallowed conflict (the winning writer's own sync already audits its write). The audited `payloadHash` is the real `envelopePayloadHash` of the just-written envelope (ciphertext domain) — `verifyBackupIntegrity` recomputes and compares that on restore, so using the plaintext `aggregateHash` there would trip a false-positive tamper failure.

**Known residual — bare `runCutover` is unaudited.** `SchemaFenceController#runCutover` (admin-triggered drain → migrate → bump) bumps the fence generation directly. If a migration's per-collection transform doesn't also go through a `_schemas/<collection>` re-declare (i.e. the schema *content* didn't change, only the fence generation moved), no `persistSchemaIfNeeded` call fires, so `syncSchemaManifest` never runs and the generation bump is not ledger-audited and not reflected in the manifest until the next unrelated schema write or an `open()` re-derive picks it up opportunistically. This is a known gap, not yet tracked by its own issue — flagged here rather than silently accepted.

## `open()` — the pod read-path orchestrator

`open(podFileOrBytes, opts)` (`with-pod/open.ts`, exported from `@noy-db/hub/pod` and the root barrel) is a **free function**, not a `Vault` method — `open()` needs no vault-internal state that isn't already reachable through published seams, and `kernel/vault.ts` is at its line ceiling. It composes, in order:

1. **`readPod`** — parse + integrity-check the container. Throws `BundleIntegrityError` on a corrupted/truncated pod, or on a body that doesn't hash to the header's claimed `bodySha256` (see "tampered-pod fail-closed" below).
2. **`verifyPodHeader`** — only when `opts.trustedKeys` is supplied. `'unsigned'` is benign (legacy pod, or `writePod({ sign: false })`) and `open()` proceeds; `'untrusted'` / `'tampered'` are fail-closed — `PodHeaderVerificationError` — mirroring `followRedirects`'s `RedirectBadSignatureError` posture: once a caller opts into verification, an unverifiable header is a hard stop.
3. **`createNoydb` + `openVault` + `vault.load(dumpJson)`** — the same unlock+restore sequence a manual bundle round-trip drives by hand. The pod header deliberately carries no vault name (minimum-disclosure), so the caller names the target vault via `opts.vault`.
4. **Re-derive the `SchemaManifest`** from the just-restored `_schemas/*` (the source of truth), via a `getDEK` resolver rebuilt from the published `loadKeyring` + `ensureCollectionDEK` (`@noy-db/hub/team`) — the same persisted `_keyring/<user>` file, same crypto as `Vault`'s own (private) DEK resolver, not a shortcut.
5. **Generation fence check** — compare the pod's schema generation against the reader's local generation (see next section).

`OpenPodResult` returns `{ db, vault, header, manifest, verification? }` — `verification` present only when `trustedKeys` was supplied.

## The generation fence — and its fresh-read over-eagerness

Step 5 compares the **highest per-collection generation stamp** carried by the restored manifest (`podGeneration`) against **this store's** schema-fence generation as it stood immediately before the restore (`readerGeneration` — 0 for a brand-new vault, whatever a coexisting local vault already had). This deliberately reads per-collection entries, not `manifest.generation` itself: `_meta/schema-fence` is local session-coordination state and does **not** travel in a pod dump (`with-pod/backup.ts`'s reserved-collection list carries `_schemas` and `_manifest` but not `_meta`), so a fresh re-derive's top-level `generation` is always driven by the untouched-by-restore target store's own fence, not the pod's. Each `_schemas/<collection>` envelope's own `generation` field *does* travel (it's stamped at declare-time from the writer's real fence), so per-collection entries are the only signal that survives a restore intact.

If `podGeneration > readerGeneration` and `!opts.allowGenerationAhead`, `open()` throws `MigrationRequiredError` — the same class the write-path fence (`SchemaFenceController#assertWritable`) throws. `allowGenerationAhead: true` opens anyway, with a `console.warn`.

**Over-eager on a fresh-store read.** Because `readerGeneration` starts at 0 for any brand-new store, opening a pod that has ever been through even one schema migration (`podGeneration ≥ 1`) into a fresh store **always** trips the ahead-check and throws `MigrationRequiredError`, even though there is no local vault to reconcile against and no genuine ambiguity — the pod is simply the only source of truth. This is by design: it's the same posture as the coexistence case (explicit code-config + manifest-bearing pod → code wins, fence still enforced, dev-mode divergence warning), generalized to "any local generation lower than the pod's is treated as needing acknowledgment." But it means a plain "read this already-migrated pod into an empty store" call needs `allowGenerationAhead: true`, which is easy to be surprised by. Documented here so it isn't a silent footgun: **a first-open of a migrated pod into a fresh store requires `allowGenerationAhead: true`.**

## Errors and fail-closed policy

| Error | Thrown when |
|---|---|
| `BundleIntegrityError` | Corrupted/truncated pod, or body hash doesn't match the header's `bodySha256`. |
| `PodHeaderVerificationError` | `trustedKeys` supplied and verification result is `'untrusted'` or `'tampered'`. |
| `MigrationRequiredError` | Pod's schema generation is ahead of the reader's and `allowGenerationAhead` wasn't set. |
| `ManifestConflictError` | A direct `writeSchemaManifest` call loses a strict-CAS race. |

The posture throughout is **fail-closed**: a tampered or unverifiable pod never opens quietly degraded — it's a hard stop, matching `followRedirects`'s `RedirectBadSignatureError` precedent. `verifyPodHeader`'s `'verified'` only authenticates the header (including the *claimed* body hash); `readPod`'s own hash check is what actually authenticates the body — a consumer that wants both must run both (see `docs/subsystems/pod-signature.md`).

## Signing and what doesn't travel

Manifest writes are ledger-audited (above) but **not yet signed** — the family-wide signing convention (`with-pod/signature.ts`'s `signRecord`/`verifyRecord`, already used by the pod header (#943) and the Redirect record (#944)) is the intended seam for it, but wiring **manifest signing** end-to-end (chain-verified re-points, not just ad-hoc record signing) is a companion issue, not built here. Separately: the schema-fence generation itself (`_meta/schema-fence`) is local session-coordination state and does not travel in a pod dump — only each collection's own stamped `generation` inside `_schemas/<collection>` does (see the fence section above).

## Species-aware, not error-aware

A pod without an app manifest is a defined, first-class state, not an error — `open()` succeeds; zero inline data collections is a valid degree too. This mirrors the existing per-collection readiness surface (`describe()`'s "not yet pulled" ≠ "empty"), generalized to the pod level: a manifest-bearing pod's absence of a *kind* of manifest (behavior/storage/access/app — none built yet) is not a failure mode.

## Relations

- Consumes: header/signature layer (#942 plaintext-header fields, #943 Ed25519 signing), stable field IDs + generation↔content-hash binding (#946).
- Orthogonal, pre-existing: #964 (coordinated-cutover data pods are unrestorable when history is on — a `payloadHash=''` migration-entry bug in `verifyBackupIntegrity`) is a separate defect in the restore/integrity path, not introduced by the manifest engine and not fixed here.
- Out of scope for this issue: the other four manifest kinds' writers (behavior/storage/access/app — P1-P3), manifest signing / chain-verified re-points (companion issue), and the write half of `open()` (open-for-write / migration execution beyond the fence check — this is the Tier-1 READ path per the spec).
