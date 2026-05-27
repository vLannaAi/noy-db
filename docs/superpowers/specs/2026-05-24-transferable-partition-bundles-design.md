# Transferable partition bundles — design (#201–#209)

> Consolidating design for [milestone 10 — Transferable bundles](https://github.com/vLannaAi/noy-db/milestone/10),
> decomposing umbrella issue [#198](https://github.com/vLannaAi/noy-db/issues/198).
>
> This document does **not** re-state the nine step issues — each already
> carries its own detailed spec. It owns the **cross-cutting** layer that no
> single issue owns: the end-to-end lifecycle state machine, the consolidated
> bundle wire format, the invariants that span multiple steps, and the
> build-order wiring. Per-step mechanics: follow the issue links.
>
> Grounds against the at-* foundation doc
> [`2026-05-23-sealing-at-dimension-foundation.md`](./2026-05-23-sealing-at-dimension-foundation.md)
> §12 (bundle transformation taxonomy) and §13 (partition × sealing soundness).

## 1. Scope

**In scope** — the non-destructive extraction → handover → adoption → ownership
ceremony, steps #201 through #209:

| # | Surface | Layer |
|---|---------|-------|
| [#201](https://github.com/vLannaAi/noy-db/issues/201) | `setupNewVaultIdentity` + `walkClosure` (internal) | hub |
| [#202](https://github.com/vLannaAi/noy-db/issues/202) | `describeExtraction()` dry-run | hub |
| [#203](https://github.com/vLannaAi/noy-db/issues/203) | `extractPartition()` core (unowned bundle) | bundle |
| [#204](https://github.com/vLannaAi/noy-db/issues/204) | `carrySchemas` opt-in | bundle |
| [#205](https://github.com/vLannaAi/noy-db/issues/205) | `carryLedger` opt-in | bundle |
| [#206](https://github.com/vLannaAi/noy-db/issues/206) | transfer-seal envelope | bundle |
| [#207](https://github.com/vLannaAi/noy-db/issues/207) | `adoptPartition()` | bundle |
| [#208](https://github.com/vLannaAi/noy-db/issues/208) | `createOwnerOnAdoptedPartition()` | hub |
| [#209](https://github.com/vLannaAi/noy-db/issues/209) | transfer-seal cleanup | hub |

**Out of scope** (decided 2026-05-24):

- **Source-side delete** (`source.onExtracted: 'delete-extracted'`). The umbrella
  #198 sketches it in the API, but it requires the cross-vault atomic transaction
  flagged as open design in foundation §13.4, and destructive withdrawal is owned
  by sibling [#199](https://github.com/vLannaAi/noy-db/issues/199). The whole
  ceremony here is **non-destructive on the source vault** — handover is by copy.
- **#197 auto-passphrase / sealed-passphrase carry.** Orthogonal read-time
  auto-unlock; composes via the existing `autoUnlock` header field but is its own
  issue. An extracted partition MAY later be sealed under a `SealingKeyProvider`,
  but that is not part of this ceremony.
- **#199 client-initiated portability / withdrawal.** Same machinery
  (`walkClosure` + re-key + `setupNewVaultIdentity`), different entry point
  (`vault.user.*`), different policy/defaults. Separate spec.
- **Asymmetric transfer seals** (`rsa-oaep` etc.). Slice 1 is
  `aes-256-gcm-pre-shared` only; asymmetric variants follow when handover-capable
  `at-*` providers ship.

## 2. Lifecycle state machine

The load-bearing model. An extracted partition moves through four states; each
transition is owned by exactly one primitive, has explicit preconditions, and
writes ledger entries.

```
  ┌──────────────┐  extractPartition()    ┌───────────────────────────┐
  │ SOURCE VAULT │ ────── #203/#206 ─────> │ EXTRACTED BUNDLE          │
  │ owned, full  │                         │ bundleKind=               │
  │ keyring      │  source ledger:         │  'extracted-partition'    │
  └──────────────┘  partition-handed-      │ _keyring: EMPTY           │
                    over:<sealId> (#203)   │ transferSeal present      │
                                           │ dest KEK sealed in body   │
                                           └─────────────┬─────────────┘
                                                         │ adoptPartition(
                                                         │   bytes, { transferKey,
                                                         │   destinationStore, vaultName })
                                                         │ #207 — unseal KEK, import to store
                                                         v
                            ┌─────────────────────────────────────────┐
                            │ ADOPTED, UNOWNED                          │
                            │ _meta/adoption present                    │
                            │   { sealId, adoptedAt }                   │
                            │ _keyring still EMPTY                       │
                            │ adoption.needsOwner = true                │
                            └─────────────────────┬─────────────────────┘
                                                  │ createOwnerOnAdoptedPartition(
                                                  │   store, vaultName,
                                                  │   { userId, passphrase, transferKey })  #208
                                                  │ + automatic seal cleanup                #209
                                                  │ (then createNoydb opens it normally)
                                                  v
                            ┌─────────────────────────────────────────┐
                            │ OWNED                                     │
                            │ recipient owner keyring exists            │
                            │ transferSeal DESTROYED                    │
                            │ _meta/adoption = { sealId, consumedAt }   │
                            │ ledger: creation-of-new-owner +           │
                            │   transfer-seal-consumed                  │
                            └───────────────────────────────────────────┘
```

### 2.1 Cross-cutting invariants

These span multiple step issues; the implementation must hold all of them. Each
is frequently two issues' acceptance criteria viewed from one angle.

1. **Seal ⇒ unowned ⇒ unconsumed.** `transferSeal` present in a bundle ⇒
   `_keyring` empty ⇒ (once adopted) `_meta/adoption.consumedAt` absent. Unifies
   #207 "double-adoption rejected" and #209 "consumed state persists locally".
2. **Transfer key never travels in the bundle.** `extractPartition` mints a
   random 32-byte transfer key, returns it to the sender out-of-band, and seals
   only the destination KEK under it. The bundle bytes alone are inert — anyone
   holding them but not the transfer key cannot adopt.
3. **One-time per destination, not per bundle.** Re-adopting the *same* original
   bundle bytes into a *different* store succeeds (the bytes are unchanged);
   re-adopting into the *same* store fails (local consumed marker in
   `_meta/adoption`). The one-time semantic is enforced at the destination, not
   by mutating the artifact.
4. **Non-destructive of source records.** No primitive in this ceremony deletes
   or modifies a source *record*. The source does receive one audit append —
   `extractPartition` writes a `partition-handed-over:<sealId>` ledger entry
   (§4.2 #203) — but the record set is untouched and the source keeps its copy.
5. **`extractPartition` requires source-vault OWNER role.** Producing a re-keyed
   standalone partition is an ownership operation, not an admin grant/revoke.
   `extractPartition` rejects a non-owner caller with a typed error (`PolicyError`
   / `AuthorizationError` per the existing policy-gate pattern). This is the
   source-side exfiltration guard of #198: only an owner can spin a partition off.
6. **Ownership is established recipient-side.** `createOwnerOnAdoptedPartition`
   mints a recipient-chosen owner locally. The #198 source-side constraint that
   the new owner pre-exist in the source keyring does not apply to this ceremony,
   because the bundle is handed over unowned and the recipient — not the source —
   decides who owns the adopted copy. (The source-side gate that matters is
   invariant 5: who may call `extractPartition` at all.)
7. **Walk is plaintext, read-only.** `walkClosure` runs inside the unlocked source
   session over decrypted records. Mutating records during a walk is undefined
   behavior — same constraint as `writeNoydbBundle`'s `where` today.

## 3. Wire format

The current bundle header (`packages/hub/src/bundle/format.ts`) is a strict
**minimum-disclosure allowlist**: `ALLOWED_HEADER_KEYS` rejects any unknown key
at parse time, and the file-level doc states new fields require a format-version
bump and validator update. We honour that — only tiny enums go in the header; all
payload bytes go in the (compressed) body.

### 3.1 Header additions

```ts
// packages/hub/src/bundle/format.ts — NoydbBundleHeader
interface NoydbBundleHeader {
  // existing: formatVersion, handle, bodyBytes, bodySha256, publicEnvelope, autoUnlock (#197)

  /**
   * Bundle's role in the source → destination lifecycle.
   *   - omitted / 'snapshot' (default): backup/copy of an existing vault.
   *   - 'extracted-partition' (#203): re-keyed projection awaiting adoption.
   */
  readonly bundleKind?: 'snapshot' | 'extracted-partition'

  /**
   * Transfer-seal INDICATOR (#206) — metadata only, no payload. Present iff
   * bundleKind === 'extracted-partition'. The sealed destination KEK lives in
   * the body (_meta/transfer-seal), NOT here, to keep the header
   * minimum-disclosure.
   */
  readonly transferSeal?: {
    readonly v: 1
    readonly alg: 'aes-256-gcm-pre-shared'  // slice 1
    readonly sealId: string                 // opaque consumption tracker
  }
}
```

Both keys are added to `ALLOWED_HEADER_KEYS` and validated **when present** in
`validateBundleHeader`. **`NOYDB_BUNDLE_FORMAT_VERSION` does NOT bump.** The
validator uses exact-equality on `formatVersion` (`format.ts:201` —
`h.formatVersion !== NOYDB_BUNDLE_FORMAT_VERSION` throws), so a version bump would
break reads of every existing bundle. Keeping the version and merely widening the
allowlist means:

- **Old bundles still read** on the new reader (the two new keys are simply
  absent → treated as `'snapshot'` / no seal).
- **New extracted bundles fail on old readers** — unavoidable: a pre-this-work
  reader sees `bundleKind` as a forbidden unknown key and throws. This is the
  correct failure (an old reader cannot run the adoption ceremony anyway), and it
  is the same trade-off §12.4 accepts for liberal optional-field additions.

`validateBundleHeader` also enforces the cross-field invariant: `transferSeal`
present ⇒ `bundleKind === 'extracted-partition'` (and vice-versa), rejecting
mismatched combinations at parse time.

Cloud listers can therefore see *"sealed extracted partition, sealId X"*
pre-decompression without the header carrying crypto bytes.

### 3.2 Body documents

New internal documents inside the compressed body (opaque to the store, re-using
the existing dump/import path):

```ts
// In the extracted bundle body:
_meta/transfer-seal = {
  v: 1,
  alg: 'aes-256-gcm-pre-shared',
  sealId: string,
  payload: base64( AES-256-GCM( destinationKEK, transferKey ) ),  // iv + ct + tag
}

// Written into the destination store by adoptPartition (#207):
_meta/adoption = {
  sealId: string,
  adoptedAt: string,        // opaque-clock timestamp
  needsOwner: boolean,      // true until #208 runs
  consumedAt?: string,      // set by #209 after owner creation
  transferSeal?: {...},     // copied at adoption; CLEARED by #209
}
```

`_keyring` and `_ledger` are **empty** in the extracted bundle by default (#203).
`carrySchemas` (#204) and `carryLedger` (#205) opt back into `_schemas/*` and the
ledger collections, re-keyed under destination DEKs.

## 4. Primitives and per-issue ownership

Reference the issue for mechanics; this table is the wiring map.

### 4.1 Internal foundations (#201)

- **`setupNewVaultIdentity(opts)`** — factors `createNoydb`'s identity-creation
  phase (keyring mint, KEK derivation, DEK wrap, recovery enrollment, public
  envelope) into a reusable internal. No-functional-change refactor; the full
  `createNoydb` suite must pass unchanged. Consumed by `createNoydb` today and
  `createOwnerOnAdoptedPartition` (#208) tomorrow. Shape in foundation §13.2.
- **`walkClosure(vault, { seeds, maxDepth })`** — fixed-point FK traversal over
  plaintext records. **The FK graph is auto-derived from the existing
  `RefRegistry`** (the `ref('target')` declarations already on collections) —
  decided 2026-05-24, per foundation §13.4 ("compose with declared FKs rather than
  requiring redundant declaration"). The caller supplies only `seeds`; no
  hand-written `followReferences` array. Seen-set cycle break, `maxDepth` default
  16, returns `{ closure: Map<collection, Set<id>>, graph: { depth, cyclesDetected } }`.
  (The step issues #201/#202/#203 show an explicit `followReferences` parameter;
  this design supersedes that with registry auto-derivation. An explicit-edge
  override may be added later if undeclared/computed FKs need extracting, but it is
  out of scope for slice 1.) `cyclesDetected` reflects revisits during the
  **inbound scope-expansion** phase only; outbound FK-completion reaching an
  already-selected parent is normal DAG convergence and is not flagged. A record
  whose `id` is not a string fails loud with `PartitionExtractionError` rather than
  being silently dropped (a dropped record would dangle an FK in the bundle).

### 4.2 Sender side

- **`describeExtraction(vault, { seeds, followReferences, maxDepth? })`** (#202) —
  read-only dry-run. Counts, byte totals, oldest/newest `_ts` from envelope
  metadata (no decrypt); decrypt only for seed predicates + FK field resolution.
  `inaccessible[]` lists records the caller's keyring couldn't decrypt (graph
  cut). Writes nothing.
- **`extractPartition(vault, opts)`** (#203 + #206) — the core. Returns
  `{ bundleBytes, transferKey, sealId }`.
  1. `walkClosure` → closure set.
  2. Mint fresh destination KEK + per-collection DEKs.
  3. Re-encrypt each closure envelope's `_data` under the destination DEK.
  4. Mint a random 32-byte transfer key; seal the destination KEK under it into
     `_meta/transfer-seal`.
  5. Write bundle: `bundleKind: 'extracted-partition'`, empty `_keyring`, empty
     `_ledger` (default), `transferSeal` header indicator, optional
     `_meta/public-envelope` override.
  6. **Write source ledger entry `partition-handed-over:<sealId>`** — assigned to
     this primitive (no other step owned it).
  - **`carrySchemas: true`** (#204, default false) — re-key `_schemas/<col>` for
    every closure collection under the destination DEK.
  - **`carryLedger: true`** (#205, default false) — filter `_ledger`,
    `_ledger_deltas`, `_history` to closure-relevant entries; re-key under
    destination DEKs. Actor user IDs preserved verbatim as informational (the
    actors' keyrings do not travel).

### 4.3 Recipient side

- **`adoptPartition(bytes, { transferKey, destinationStore, vaultName })`** (#207)
  — verify `bundleKind === 'extracted-partition'` and `transferSeal` present →
  unseal destination KEK with `transferKey` (AES-GCM auth-tag failure on wrong
  key) → import body into `destinationStore` under `vaultName` → write
  `_meta/adoption` with `needsOwner: true`. Returns
  `{ vaultName, needsOwner: true, sealId }`. Vault is queryable but sensitive ops
  require an owner.
- **`createOwnerOnAdoptedPartition(store, vaultName, { userId, passphrase, transferKey })`**
  (#208) — a **free, store-level function** (NOT `createNoydb({ expecting: … })`;
  the `expecting:` flag was dropped 2026-05-25 in favour of a separate explicit
  call, which preserves the same no-silent-detection safety with no `createNoydb`
  open-path surgery). Preconditions: `_meta/adoption` present + unconsumed,
  `_keyring` empty (else `AdoptionStateError`). Recovers the partition DEKs by
  re-unsealing with `transferKey`, mints the recipient owner via the existing
  `createOwnerKeyring` primitive (the planned `setupNewVaultIdentity` refactor is
  **not needed** — `createOwnerKeyring` already is that primitive), then merges the
  partition DEKs wrapped under the recipient KEK into the keyring. **Scope: standard
  passphrase mode only** — recovery enrollment at owner-create and
  `passphraseMode: 'managed'` (with #195/#196/#14 composition) are deferred to
  follow-ups; the recipient enrols recovery post-hoc via `db.enrollRecovery(...)`.
  After this the recipient opens the vault normally via `createNoydb({ store, user,
  secret })`.
- **Transfer-seal cleanup** (#209) — runs automatically inside
  `createOwnerOnAdoptedPartition` once the owner keyring is written. Clears
  `_meta/adoption.transferSeal`, retains `sealId` + sets `consumedAt`. (The
  destination-side `creation-of-new-owner` / `transfer-seal-consumed` ledger
  entries are **deferred to [#226](https://github.com/vLannaAi/noy-db/issues/226)**,
  not skipped: the adopted partition starts with an empty ledger so there is no
  chain to append to yet, but once `carryLedger` (#205) ships there is one and these
  entries belong on it.)

## 5. Build order

PR boundaries (matches the issue author's step order; mirrors the
spec → niwat-review → multi-PR-epic pattern):

1. **#201** — `setupNewVaultIdentity` + `walkClosure`. No-functional-change
   refactor + new internal; lands first because everything depends on it.
2. **#202** — `describeExtraction` (consumes `walkClosure`).
3. **#203 + #206 (paired PR)** — extraction core + transfer seal. Paired because
   an extracted bundle is unusable without its seal; shipping #203 alone would
   leave a header surface (`bundleKind`) with no adoption path.
4. **#204, #205 (parallel)** — `carrySchemas`, `carryLedger`. Independent opt-ins
   on top of #203.
5. **#207** — `adoptPartition`.
6. **#208** — `createOwnerOnAdoptedPartition`.
7. **#209** — seal cleanup (depends on #208).

## 6. Errors

New error types, following the `errors.ts` pattern and re-exported from
`bundle/index.ts` so subpath consumers can `instanceof` them:

- **`PartitionExtractionError`** — walk failure, re-key failure, `maxDepth`
  exceeded without convergence.
- **`TransferSealError`** — wrong transfer key (surface the AES-GCM auth-tag
  failure), missing/malformed seal, adopting a bundle without `transferSeal`.
- **`AdoptionStateError`** — `createOwnerOnAdoptedPartition` on a non-adopted
  vault (no `_meta/adoption`), or a second owner-create after consumption,
  double-adoption into the same store.

## 7. Testing

TDD per project norm.

- **Per-primitive unit tests**: `walkClosure` (cycles, `maxDepth`, graph cut on
  inaccessible records), `describeExtraction` (counts without decrypt), re-key
  correctness (closure envelopes open under destination DEK, not source),
  `carrySchemas`/`carryLedger` on/off/partial matrices, wrong-key adoption,
  missing-seal adoption, double-adoption rejection, cleanup idempotency.
- **End-to-end ceremony test** (the niwat hotel-department scenario): seed
  `clients` by `operatorUserId`, follow the bill/receipt/payment/worker FK graph,
  `extractPartition` → `adoptPartition` into a fresh store →
  `createOwnerOnAdoptedPartition` → `createNoydb({ store, user, secret })` opens it
  normally. Assert: source vault unchanged (non-destructive), destination owned by
  the recipient, transfer seal destroyed, every FK in the partition still resolves.
  (Source `partition-handed-over` + destination `creation-of-new-owner` /
  `transfer-seal-consumed` ledger entries are deferred to [#226](https://github.com/vLannaAi/noy-db/issues/226)
  — see §4.3.)

## 8. Docs & catalog

- Extend `docs/subsystems/` (bundle + sealing sections) with the lifecycle and
  the adoption ceremony.
- Register every new public surface (`describeExtraction`, `extractPartition`,
  `adoptPartition`, `createOwnerOnAdoptedPartition`, the new errors, the
  `bundleKind`/`transferSeal` header fields) in `features.yaml` — the master
  spec↔artefact graph; CI's "Spec coverage" job fails on dangling refs.
- Cross-reference foundation §12 (taxonomy) and §13 (soundness) in both
  directions.

## 9. Performance note

`walkClosure` is O(records-per-closure-collection × graph diameter). For
consumer-firm-scale vaults (10k–100k records, ≤20 collections, FK depth ≤5) this
is tractable. Document the bound; opt-in pagination deferred (foundation §13.4).
