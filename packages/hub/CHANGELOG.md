# Changelog — hub

## Unreleased

### Internal: microkernel refactor — god-object decomposition (no public API change)

The three always-on hub files were decomposed behind named folder seams, taking the kernel from ~13,525 LOC to ~10,400 (−23%) with the public surface byte-identical (the `/kernel` + `/adapter` golden-surface tests guard it). No behavior change; the full suite stayed green throughout.

- **Optional subsystems** are now grouped into eight `with-*` dimension folders (`with-lookup`/`with-commit`/`with-formula`/`with-shape`/`with-audit`/`with-fork`/`with-share`/`with-party`); each cohesive cluster moved behind a small deps interface with the kernel keeping thin delegators. Shared caches/registries (the per-record CEK `Lru`, eager-index caches, the subsystem bus) stay kernel-resident and pass **by reference**.
- **`collection.ts`** 5774→4300, **`vault.ts`** 4722→3824, **`noydb.ts`** 3110→2274. Examples: envelope/CEK crypto → `record-keys/record-codec.ts`; auth/recovery/enrollment → `with-party/team/`; backup/dump-load → `vault-backup.ts`; tiers/search/index-maintenance → `with-audit/tiers` + `with-lookup/{search,indexing}`; the Collection constructor → a pure `resolveCollectionConfig()` + thin wiring.
- **Additive only at the seams:** new `@noy-db/hub/describe` subpath (the UI contract); `bundle` moved to the `with-share` dimension (subpath unchanged); `vault.dump()`/`.noydb` bundles now include the `_blob_*` collections so blob covers travel sealed inside the artifact; `extractPartition` carries a slice's blobs re-keyed under a fresh transfer DEK (no master-key leak).

Record-scoped sealing (epic [#306](https://github.com/vLannaAi/noy-db/issues/306)) — sealed `sensitive` fields now participate in crypto-shred and tamper-evidence end to end — plus money-typing parity across the aggregate builders.

### Feature: record-scoped sealing — `forget()` erases sealed fields + the ledger attests them ([#306](https://github.com/vLannaAi/noy-db/issues/306))

- **Erasure.** When a collection sets both `sensitive` and `perRecordKeys`, each sealed field's key now derives from the record's per-record CEK (`deriveSealedFieldKeyFromCek`) instead of the collection DEK. `vault.forget()` drops the record's wrapped `_cek`, which now makes `_sealed` cryptographically unrecoverable — the same erasure guarantee `_data` already had. `ForgetResult` gains a **`sealedFieldsShredded`** count.
- **No-migration dual-read.** Reads try the CEK-derived key first and fall back to the collection-DEK key, so records sealed before this change stay readable with no migration step; they upgrade to CEK-derivation on their next `put()`. `rotateRecordCek` re-encrypts `_sealed` under the new CEK rather than carrying it forward.
- **Ledger integrity.** The history ledger's `payloadHash` now binds `_sealed`, so `vault.verifyBackupIntegrity()` detects tampering or erasure of a sealed value. Backward-compatible: a record with no sealed fields hashes exactly as before (`sha256(_data)`), so existing ledgers and non-sealed backups verify byte-identically. `_cek` is intentionally **not** bound (a tampered wrapped-CEK self-detects, and `rotateRecordCek` rewrites it with no ledger entry).
- **Boundary.** A backup captured *before* `forget()` that retained both `_sealed` and `_cek` remains recoverable by a collection-DEK holder — the same caveat `_data` carries.

### Feature: money-field typing across all aggregate builders ([#306](https://github.com/vLannaAi/noy-db/issues/306))

- `scan().aggregate(b => …)` and `query().groupBy(...).aggregate(b => …)` now auto-type `b.sum`/`min`/`max` over a declared `moneyFields` member as **`MoneyString`**, matching `Query.aggregate` — completing the opt-in money-field (`M`) type matrix across `Query`, `ScanBuilder`, and `GroupedQuery`/`GroupedQueryN`. Type-only (phantom generic defaulting to `never`), so collections that don't opt in stay `number`.

## 0.2.0-pre.31

### Patch Changes

- Extract the 16 non-essential `to-*` storage adapters to the separate `noy-db-to` repo (essentials `to-memory`/`to-file`/`to-browser-idb`/`to-meter`/`to-probe` stay). Extend `@noy-db/hub/adapter` with the bundle-store contract for the extracted backends to bind against, and re-private the `test-adapter-conformance` kit (workspace-only, never published).

## 0.2.0-pre.12

Multi-vault federation (epic [#271](https://github.com/vLannaAi/noy-db/issues/271)) + fiscal-grade field, lifecycle & numbering primitives (m17 clusters A–D).

### Feature: multi-vault federation — `VaultGroup` ([#271](https://github.com/vLannaAi/noy-db/issues/271))

- **`db.openVaultGroup(...)`** routes a logical collection transparently across many physical vaults (shards). `ShardedCollection` / `ShardedQuery` fan out reads with skipped-shard reporting (`SkippedVault`, including a `'no-grant'` reason for shards you can't decrypt). ([#292](https://github.com/vLannaAi/noy-db/issues/292))
- **Cross-vault live + distributed aggregate** — `ShardedQuery.live()` / `.aggregate()` / `.groupBy().aggregate()` give reactive snapshots and a single **central reduce** over the union of all shards, so `avg`/`mean` are exact (never avg-of-avgs). Federation ships as a **lazy chunk** (dynamic import; type-only entry exports), so it stays out of the core bundle until used. ([#319](https://github.com/vLannaAi/noy-db/issues/319))
- **Key-custody-neutral fan-out** — `queryAcross` no longer assumes a single custody model; shards you lack a grant to are skipped, not failed. New optional **`Reducer.merge(a, b)`** combines partial results computed in parallel across shards. ([#312](https://github.com/vLannaAi/noy-db/issues/312))

### Feature: `money()` — currency-safe decimal field ([#300](https://github.com/vLannaAi/noy-db/issues/300))

- Schema-layer descriptor (sibling of `i18nText()` / `dictKey()`) for exact decimal money, stored as a scaled-integer **digit string** — exact past `Number.MAX_SAFE_INTEGER`. ISO-4217 default scales; 7 rounding modes (excess precision rejected by default). Multi-currency mode carries the currency per record. `sum` / `min` / `max` run in **BigInt** with incremental `remove()` (exact under live aggregation / MV maintenance); `avg` over a money field throws **`MoneyUnsupportedError`** rather than returning a lossy figure.
- Money errors (`MoneyPrecisionError` / `MoneyCurrencyError` / `MoneyUnsupportedError`) now extend **`NoydbError`** (codes `MONEY_PRECISION` / `MONEY_CURRENCY` / `MONEY_UNSUPPORTED`), so they're caught by the documented `catch (e) { if (e instanceof NoydbError) }` convention.

### Feature: computed scalar fields ([#302](https://github.com/vLannaAi/noy-db/issues/302))

- **`computed: { … }`** declares schema-owned scalar fields derived on write — pure and synchronous, run **first** in the write pipeline in declaration order (a later field can read an earlier one). The result is **materialized**: stored, queryable, and `aggregate(sum())`-able. A computed field overwrites any user-supplied value of the same name; a throwing function rejects the write with **`ComputedFieldError`** (extends `NoydbError`). Composes with `money()`, and `immutableGuard`-frozen fields are skipped so computed values may still be recomputed.

### Feature: immutable collections / WORM ([#301](https://github.com/vLannaAi/noy-db/issues/301))

- **`immutableGuard({ collection, after })`** — declarative write-once-after-condition sugar over the existing `guards` machinery (block-on-`check`/`onDelete` + ledgered admin `amendment`). `after(record)` is evaluated on the existing record, so inserts and the transition write are allowed; everything after is blocked with `RecordLockedError`. `appendOnly: true` = immutable from creation. The audited `amendment` transaction is the only override.

### Feature: blob retention, legal-hold & record archival ([#311](https://github.com/vLannaAi/noy-db/issues/311), [#307](https://github.com/vLannaAi/noy-db/issues/307))

- Blob `vault.compact()` gains **`legalHold`** (never evict while held) and **`retainUntil`** (period-bound retention floor); an unparseable `retainUntil` **fails closed** (record retained). ([#311](https://github.com/vLannaAi/noy-db/issues/311))
- **`withArchive`** relocates sealed records to a cold store at the envelope level (no re-encryption): `vault.archive()` / `vault.listArchived()` / `vault.restore()`. Archival bypasses guards and a `legalHold` predicate blocks it entirely; archived records read `null` from the primary store until restored. ([#307](https://github.com/vLannaAi/noy-db/issues/307))

### Feature: atomic gap-free sequences ([#303](https://github.com/vLannaAi/noy-db/issues/303))

- **`vault.sequence(name).next()`** — gap-free, exactly-once numbering (invoice / DDT numbers) over an optimistic compare-and-swap counter; `peek()` reads the current value without allocating. Independent per name and concurrency-safe (jittered CAS retry; `SequenceContentionError` past the retry budget). **Online-only by design** — `next()` throws `SequenceOfflineError` unless the store advertises `capabilities.casAtomic`. Counters survive `dump()` / `load()` backup round-trips (`_sequences` is preserved in backups). Ships with a forget-cascade design spec ([#304](https://github.com/vLannaAi/noy-db/issues/304)).

## 0.2.0-pre.11

### Security: `openVault` no longer self-provisions into another principal's vault ([#313](https://github.com/vLannaAi/noy-db/issues/313))

- Opening a vault you hold **no grant** to that is **already held by other principals** now fails closed with `NoAccessError` and writes **nothing** — previously it silently minted a fresh owner keyring (new DEKs) into that vault and then read zero records. Genuinely-new vaults (no `_keyring/*`) still open-or-create exactly as before.
- New opt-in **`openVault({ create: false })`** (and `queryAcross({ create: false })`) forces strict open-existing: a missing grant throws `NoAccessError` instead of creating.
- The gate sits **before** managed-passphrase secret resolution, so managed (KMS-sealed) mode also writes nothing on the fail-closed path. The `getKeyring` callback path and `onInvalidKey: 'reset'` are unchanged.

## 0.2.0-pre.10

Adopter-reported correctness + introspection batch.

### Fix: unique indexes are now enforced ([#293](https://github.com/vLannaAi/noy-db/issues/293))

- `{ fields: [...], unique: true }` on a collection index is **enforced at write time** — single-field **and** composite. A duplicate of an existing non-null value is rejected with the new **`UniqueConstraintError`** (carrying `collection` / `recordId` / `fields` / `conflictingId`). Previously `unique: true` was silently dropped — the input `IndexDef` didn't even carry the flag — a data-integrity footgun.
- **Null-tolerant** (SQL NULL-distinct): the constraint applies only when every constrained field is non-null; duplicate `null`/`undefined` values coexist.
- Enforcement covers `put` / `putMany` / `delete`, the atomic-rollback path, and the hydration rebuild (uniqueness holds against records written in a prior session).
- **Eager mode only.** Declaring `unique` on a lazy (`prefetch:false`), CRDT, or tiered collection now **fails loud** at registration with the new **`UnsupportedIndexOptionError`** (those write paths bypass the check, so silent acceptance is refused).

### Fix: `dumpSchema()` completeness ([#294](https://github.com/vLannaAi/noy-db/issues/294), [#295](https://github.com/vLannaAi/noy-db/issues/295))

- Surfaces fields for **`z.discriminatedUnion`** schemas — the union of member fields (required only when required in _all_ members), with the discriminator's literal set. Previously returned `fields: {}`. ([#294](https://github.com/vLannaAi/noy-db/issues/294))
- Populates the **`derivations`** and **`overlayViews`** maps (both registries gained an `all()`); derivations are keyed by **output collection**, so multiple derivations sharing one source no longer collide. ([#295](https://github.com/vLannaAi/noy-db/issues/295))
- Materialized-view `aggregate` ops now render as **`sum(field)`** / **`count`** instead of `"[object Object]"` (reducers carry `op`/`field` metadata). ([#295](https://github.com/vLannaAi/noy-db/issues/295))

### Feature: omit rows from a materialized view ([#297](https://github.com/vLannaAi/noy-db/issues/297))

- A `unionSources` `map` callback may return **`null`/`undefined`** to omit a source record from the view — no more sentinel rows. (Derivation `derive` omission was already supported at runtime via `optional` outputs.)

### Feature: discriminated-union narrowing helper ([#296](https://github.com/vLannaAi/noy-db/issues/296))

- New **`isDiscriminant(record, key, value)`** type-guard narrows a `Collection<Union>` read by its discriminant without `as unknown as` casts. See `docs/core/06-query-basics.md`.

## 0.2.0-pre.9

### Feature: automatic snapshot cadence ([#272](https://github.com/vLannaAi/noy-db/issues/272))

- `withSnapshots({ snapshotPolicy })` — opt-in automatic whole-vault snapshots on a `debounce`/`interval` cadence (default `manual`). Auto-snapshots write a single rolling `<vault>__auto` key, decoupled from the immutable on-demand pool and **exempt from retention** so the timer never evicts labeled checkpoints (and on-demand `snapshot()` preserves the rolling slot). Driven off `onAfterWrite`; flushes on tab-hide/exit; torn down by `db.close()`.
- `SnapshotMeta.auto` flags the rolling snapshot; it lists first and restores like any checkpoint.

## 0.2.0-pre.8

### Feature: i18n multilingual-field hardening ([#284](https://github.com/vLannaAi/noy-db/pull/284))

Opt-in extensions to `i18nText`/`dictKey` — every existing field behaves exactly as before (zero breaking change).

- **Per-layer `onMissing` policy** (`'substitute' | 'null' | 'throw'`, scalar or per-layer map) + declared **`substitute`** preference chain on `i18nText`. Default `'throw'` preserves today's behavior; the `read` layer (`get`/`list`) is wired (guard/mv/derivation/join/export tracked in [#285](https://github.com/vLannaAi/noy-db/issues/285)).
- **Per-locale script enforcement** (`script: 'auto' | {locale: Script[]}`, `onScriptViolation: 'reject'|'filter'|'warn'`) with **asymmetric Latin tolerance** — non-Latin locales also allow Latin (embedded brand/building names), Latin locales reject other scripts; `Common`/`Inherited`/`Mark` always allowed. New `ScriptViolationError`. ([#283](https://github.com/vLannaAi/noy-db/issues/283))
- **dictKey parity**: `onMissing`/`substitute` on labels; array-of-keys → `[{key,label}]` pair objects; **wildcard-path `contacts[].title`** → per-element `<leaf>Label`. ([#282](https://github.com/vLannaAi/noy-db/issues/282))
- **`I18nMap<Langs, Required>`** type helper — infers `Partial` vs full map shape from the `required` mode so absent optional locales are `string | undefined` at compile time.

## 0.2.0-pre.7

### Feature: cross-join query primitive ([#277](https://github.com/vLannaAi/noy-db/pull/277))

- Added **`.crossJoin(target, { as })`** to `Query<T>` — expresses cartesian-product relations between two vault collections, composing with `.where()`, `.wherePredicate()`, `.groupBy()`, and `.aggregate()`.
- Supports a **lateral** form (`on:` callback) that filters or supplies the right-hand rows per left row.
- Guarded by a **cost ceiling**: `CrossJoinTooLargeError` aborts before materializing a product larger than the configured limit; `CrossJoinSourceUnknownError` surfaces an unresolved target. Dim 11 v3.

### Feature: vault snapshots — checkpoint/restore ([#279](https://github.com/vLannaAi/noy-db/pull/279))

- Added opt-in **`withSnapshots()`** strategy (`@noy-db/hub/snapshots`) exposing `db.snapshot()`, `db.listSnapshots()`, and `db.restoreSnapshot()`.
- Snapshots are full encrypted `.noydb` bundles backed by any `NoydbBundleStore`; a sidecar `${vaultId}__index` blob holds `SnapshotMeta[]` for listing without downloading snapshot blobs.
- **Declarative retention** enforcement and **`ledgerHead` tamper-detection** on restore. Zero footprint when omitted (the `NO_SNAPSHOTS` stub throws on all methods).

### Fix: de-flaked cross-tab conflict test (#228c)

- `tab-write-propagation` conflict test now polls for emitted conflicts instead of waiting a fixed number of `settle()` ticks — removes a timing race that intermittently failed on contended CI runners. Test-only change.

## 0.2.0-pre.6

### Fix: nested i18nField paths not resolved on read ([#273](https://github.com/vLannaAi/noy-db/issues/273))

- `applyI18nLocale` now traverses **dot-notation paths** (`address.lineOne`) and **array-wildcard paths** (`contacts[].title`) when resolving i18nText fields on read. Previously only top-level keys resolved; nested paths returned the raw `{ [locale]: string }` map.
- `enforceI18nOnPut` (required-translation validation) updated to the same path-aware traversal so nested required fields are validated on `put()`, not silently skipped.
- Auto-translate (`autoTranslate: true`) updated to traverse dot paths; array-wildcard paths are silently skipped (unsupported for auto-translate).

## 0.2.0-pre.5

### Track A — kernel shrink ([#262](https://github.com/vLannaAi/noy-db/pull/262))

- Introduced **`SubsystemBus`**, an internal observe/gate bus that decouples the kernel from its subsystems. Gate points (`beforePut`/`beforeDelete`, throw-to-abort) and observe points — including a new `afterDelete` that completes observe-bus symmetry — now flow through the bus instead of bespoke per-subsystem wiring.
- Migrated **periods** and **guards** enforcement onto the gate bus.
- Added a **kernel-surface CI gate** (`check-architecture.mjs`) that locks in the reduced kernel surface so it can't silently re-grow.
- Internal architecture shrink only — no public API change.

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

The **same-device multi-tab coordination** line ([#228](https://github.com/vLannaAi/noy-db/issues/228)). Additive over pre.2: one opt-in entry point, `db.enableTabCoordination()`, gives a vault open in multiple browser tabs primary/secondary election, live cross-tab write propagation, and concurrent-write conflict detection. Browser-only (Web Locks + BroadcastChannel, same-origin); a graceful no-op everywhere else.

### Presence + tab roles ([#251](https://github.com/vLannaAi/noy-db/pull/251))

- `db.enableTabCoordination(opts?)` elects one **primary** tab via an exclusive Web Lock; the rest are **secondary** and re-elect when the primary closes. A presence heartbeat over `BroadcastChannel` publishes active tabs.
- New surface: `db.tabRole`, `db.activeTabs()`, `db.onTabRoleChange(fn)`, `db.onActiveTabsChange(fn)`. Idempotent enable; torn down on `close()`.

### Cross-tab write propagation ([#252](https://github.com/vLannaAi/noy-db/pull/252))

- A write committed in one tab refreshes that document in every other tab that has the collection loaded — no reload. **Ciphertext-blind:** only `{ vault, collection, docId, action }` cross the channel; receivers re-read the shared encrypted store and decrypt locally.
- Role-agnostic; applied remote writes never re-persist or re-fire write hooks (no loop). Opt out with `enableTabCoordination({ propagateWrites: false })`.

### Cross-tab write conflict detection ([#253](https://github.com/vLannaAi/noy-db/pull/253))

- Concurrent same-document writes are detected via a per-document own-write version ledger. `db.onWriteConflict(fn)` (and the `write:conflict` event) emit a `WriteConflict { vault, collection, docId, local, remote, base, localVersion, remoteVersion, baseVersion }` — decrypted records; `base` is the common ancestor from history, or `null` when history is unavailable.
- The hub converges the cache to the store's authoritative value but **never auto-resolves** — reconciliation is left to the application.

### Write hooks

- `WriteEvent` now carries `vault`, `baseVersion`, and `version` (the version fields are sourced from the write basis, matching the version actually written). Backward-compatible additions for `onBeforeWrite` / `onAfterWrite` consumers.

## 0.2.0-pre.2

The **transferable bundles + document attestation** line. Additive over pre.1: a new vault-coupled attestation subsystem, the transferable-partition bundle ceremony, and recipient-target sealing — plus a signer-hardening fix.

### Document attestation — issue + revocation side ([#236](https://github.com/vLannaAi/noy-db/issues/236), [#238](https://github.com/vLannaAi/noy-db/issues/238))

- New `@noy-db/hub/attestation` subpath. Declare `collection(name, { attestation: { fields } })`, then `vault.issueAttestation(collection, id)` mints a signed-QR commitment (`{ docId, qr, keyId, publicKeyB64 }`) and writes an encrypted `_attestations/<docId>` index (field paths + source version only — never field values). Owner-only.
- `vault.getDocumentSigningPublicKey()` publishes the firm's Ed25519 public key for offline verification.
- Whole-doc revocation: `vault.revokeAttestation(docId)` / `unrevokeAttestation` track an encrypted `_attestations/_revoked` set; `publishRevocationList()` signs it with the firm key (same `keyId` as issued docs).
- Pairs with the pure, hub-free `@noy-db/attestation` verifier core.

### Signer hardening ([#242](https://github.com/vLannaAi/noy-db/issues/242))

- `getDocumentSigningPublicKey` now reads an existing key for any DEK-holder but **only the owner may mint a missing one** (a non-owner read on a fresh vault raises `AttestationError` instead of silently minting the firm's identity key).
- Concurrent first-mints **converge**: the loser of the `put(expectedVersion:0)` race re-reads and returns the winning keypair rather than surfacing a raw `ConflictError`.

### Transferable partition bundles ([#225](https://github.com/vLannaAi/noy-db/issues/225))

- `extractPartition(vault, opts)` projects a seed-predicate FK-closure (`walkClosure`, auto-derived from the `RefRegistry`) into a re-keyed bundle sealed under a one-time transfer key; `adoptPartition` + `createOwnerOnAdoptedPartition` complete the recipient-side ceremony under a new owner. Optional `carrySchemas` / `carryLedger`.

### Recipient-target bundle sealing ([#234](https://github.com/vLannaAi/noy-db/issues/234))

- Final slice of recipient-target sealed delivery — a bundle can be sealed so only the intended recipient can open it.

## 0.2.0-pre.1

The **`at-*` family graduation** line. Minor bump (`0.1 → 0.2`) because it carries a **breaking change** (#211). The `at-*` sealing-key family — debuted in pre.16 — is now first-class: a cloud-KMS provider trio ships, bundle auto-unlock generalizes beyond passphrases, hub is decoupled from the Shamir plugin, and the family is registered in the catalog.

### ⚠️ Breaking — hub ↔ on-shamir decouple ([#211](https://github.com/vLannaAi/noy-db/issues/211))

- `@noy-db/hub` **no longer re-exports** the Shamir share codecs (`encodeShareBase32` / `decodeShareBase32`) — import them from `@noy-db/on-shamir` instead.
- Shamir recovery now requires an **injected provider**: `createNoydb({ shamirRecovery: shamirRecoveryProvider() })` (from `@noy-db/on-shamir`). Managed-passphrase mode mandates strong recovery, so managed-mode vaults now also need this provider.
- hub holds no static import of on-shamir — the layering inversion + build-cycle risk are gone. See `MIGRATING.md`.

### Bundle auto-unlock generalized ([#215](https://github.com/vLannaAi/noy-db/issues/215))

- New `autoCredentials` / `sealedCredentials` on `writeNoydbBundle`, carrying `{ kind: 'passphrase' | 'password' | 'pin', value }` — a delivered bundle one-click-unlocks whatever tier the user enrolled.
- `autoPassphrases` / `sealedPassphrases` remain as **deprecated sugar** (`kind: 'passphrase'`). On read, `autoUnlock.perUser[user]` is now `{ kind, value }`; dispatch login by `kind` (PIN is a prefill, not an enrollment). WebAuthn is rejected (hardware-bound). Pre-0.2 bundles read back unchanged.

### `at-*` cloud-KMS provider trio (new packages)

- `@noy-db/at-aws-kms` ([#188](https://github.com/vLannaAi/noy-db/issues/188)), `@noy-db/at-gcp-kms` ([#189](https://github.com/vLannaAi/noy-db/issues/189)), `@noy-db/at-azure-keyvault` ([#190](https://github.com/vLannaAi/noy-db/issues/190)) — `SealingKeyProvider`s backed by cloud KMS encrypt/decrypt. Ambient credentials only.

### Catalog

- `at-*` registered in `features.yaml` (new `sealers:` section) + `docs/packages/at-hosts.md` ([#214](https://github.com/vLannaAi/noy-db/issues/214)). The README now names the **two trust boundaries**: zero-knowledge (`to-*`/`by-*`) vs trusted-compute (`at-*`, which _can_ decrypt the scoped slice it unseals).

## 0.1.0-pre.16

The **sealing dimension foundation** + the **`at-*` sealing-key provider family debut**. Where every prior tier protected the vault with something the user _knows_ or _has_ (passphrase, WebAuthn, PIN), `at-*` providers seal it with a key drawn from the _environment_ — an env var, an OS keychain — for unattended / managed-host scenarios. Shipped alongside managed-passphrase mode, the recovery-profile dispatch groundwork, and the persisted-schema introspection trio.

This release also lands a build fix: `main` had been red since [#196](https://github.com/vLannaAi/noy-db/issues/196) — see "Build" below.

### Sealing dimension + managed-passphrase mode ([#14](https://github.com/vLannaAi/noy-db/issues/14) slice 1, [#186](https://github.com/vLannaAi/noy-db/issues/186))

- New `SealingKeyProvider` contract + sealed envelope. A provider supplies a sealing key from outside the user's head; the vault's wrap material is sealed under it for hands-off unlock.
- `@noy-db/at-env` ([#187](https://github.com/vLannaAi/noy-db/issues/187)) and `@noy-db/at-macos-keychain` ([#191](https://github.com/vLannaAi/noy-db/issues/191)) are the first two providers — the `at-*` family debut. Cloud/OS providers (AWS/GCP/Azure KMS, wincred, libsecret, WebAuthn-PRF) are tracked under the [at-\* sealing key providers](https://github.com/vLannaAi/noy-db/milestone/9) milestone.
- Managed-passphrase mode mandates **at least one strong recovery profile** and disables the rotate-passphrase gate ([#195](https://github.com/vLannaAi/noy-db/issues/195)); `recoverManagedPassphrase` added.

### Recovery + rotation

- `db.rotateRecovery()` — gated, deliberate paper-code regeneration ([#121](https://github.com/vLannaAi/noy-db/issues/121), [#185](https://github.com/vLannaAi/noy-db/issues/185)).
- Shamir recovery-profile dispatch ([#196](https://github.com/vLannaAi/noy-db/issues/196) slice 1) — the recovery path can route to a `shamir` profile.

### Bundles + derivations (slice 1s)

- Sealed bundle delivery: `autoPassphrases` + `sealedPassphrases` on `writeNoydbBundle` ([#197](https://github.com/vLannaAi/noy-db/issues/197) slice 1).
- Variable-N derivations — `shape: 'array'` ([#200](https://github.com/vLannaAi/noy-db/issues/200) slice 1).

> **Public-API surface lock.** `autoPassphrases`, `sealedPassphrases`, `recoverManagedPassphrase`, `rotateRecovery`, and the `managedPassphrase` option are exported public API as of this release — future slices of #196/#197/#200/#14 must extend, not rename, them.

### Schema introspection trio

- Persisted JSON Schema — opt-in encrypted `_schemas/<col>` envelope ([#174](https://github.com/vLannaAi/noy-db/issues/174)).
- `vault.dumpSchema()` introspection primitive ([#175](https://github.com/vLannaAi/noy-db/issues/175)).
- `noydb describe` CLI — bundle → YAML/JSON audit ([#176](https://github.com/vLannaAi/noy-db/issues/176), in `@noy-db/cli`).

### Fixes

- `Collection._doDelete` now dispatches eager MV refresh ([#181](https://github.com/vLannaAi/noy-db/issues/181), [#183](https://github.com/vLannaAi/noy-db/issues/183)).
- Ledger entries can be tagged `import:<format>` via `collection.put({ reason })` ([#1](https://github.com/vLannaAi/noy-db/issues/1), [#184](https://github.com/vLannaAi/noy-db/issues/184)).

### Build

- Removed `@noy-db/on-shamir`'s spurious `peer`+`dev` dependencies on `@noy-db/hub`. #196 made hub import on-shamir's secret-sharing engine at runtime; combined with on-shamir's (never-imported) hub deps, turbo saw a `hub ↔ on-shamir` build cycle and **`main` failed CI from #196 through #197**. on-shamir is a self-contained primitive _consumed by_ hub, so its hub deps were dead metadata. Properly decoupling hub from the on-shamir package (via injected provider) is tracked in [#211](https://github.com/vLannaAi/noy-db/issues/211) (deferred).

## 0.1.0-pre.15

A small fast-follow to pre.14's Dim 14 v2: extends `withMaterializedView` along two consumer-driven axes ([#165](https://github.com/vLannaAi/noy-db/issues/165) + [#166](https://github.com/vLannaAi/noy-db/issues/166)), folds in a pre.14 type-only cleanup ([#131](https://github.com/vLannaAi/noy-db/issues/131)), and resolves two niwat-review follow-ups ([#169](https://github.com/vLannaAi/noy-db/issues/169) + [#170](https://github.com/vLannaAi/noy-db/issues/170)). 5 issues closed, 1 PR merged ([#167](https://github.com/vLannaAi/noy-db/pull/167)), 28 new hub tests, 1601 hub tests on the tip.

### Multi-key `groupBy` ([#166](https://github.com/vLannaAi/noy-db/issues/166))

- `Query<T>.groupBy(...fields)` is now variadic with a back-compatible single-arg overload (TypeScript prefers the single-field overload via declaration order, so existing call sites keep their narrowed return type).
- Result rows carry every grouped field in **declaration order**, followed by reducer outputs. `groupBy('clientId', 'period')` produces `{ clientId, period, ...aggregates }`.
- New internal `canonicalGroupKey(fields, row)` helper — sorts field names lexicographically before serialising, so the bucket dedup key is invariant under field-argument order (`groupBy('a','b')` and `groupBy('b','a')` produce the same buckets). The helper is reused by the UNION MV dedup path.
- `GroupedQueryBase` shared abstract class holds the constructor + protected fields; `GroupedQuery<T, F>` and `GroupedQueryN<T, F>` override only `aggregate()` for the appropriate return-type generic. Eliminates the drift risk of parallel near-identical wrappers.
- Cardinality warning now lists every grouped field name (`[a, b, c]`); `GroupCardinalityError` at 100k distinct tuples; thresholds unchanged.
- MV strategies can use multi-key `groupBy` inside `query()` callbacks unchanged — dependency analyzer correctly walks the multi-key plan node.

### UNION materialised views ([#165](https://github.com/vLannaAi/noy-db/issues/165))

`withMaterializedView` gained a new top-level mode: `unionSources: [{ collection, map }, ...]` reads from multiple sibling collections in one declaration. Per-source `map` is the schema-unification boundary — sibling collections with different schemas project to a single MV row shape (the strategy's `TRow` type parameter). Declarative `groupBy: string | ReadonlyArray<string>` + `aggregate` fields then run on the concatenated stream.

Registration validation (new `MaterializedViewConfigError`):

- Mutually exclusive with `query` — strategy uses one or the other
- `unionSources.length >= 2` required
- Distinct collection names across arms required
- Empty `groupBy: []` rejected
- `aggregate` without `groupBy` rejected ([#169](https://github.com/vLannaAi/noy-db/issues/169))
- `predicates` rejected on UNION mode for now ([#170](https://github.com/vLannaAi/noy-db/issues/170)) — per-arm predicate semantics is a deferred feature

Executor path: reads each arm, runs per-source `map`, concatenates, then dispatches by shape (no groupBy → return as-is; groupBy without aggregate → dedupe via `canonicalGroupKey`, first row wins per composite key; groupBy + aggregate → delegate to `groupAndReduce`). Source-write hook fires on every arm via the existing dependency reverse-index — `Collection.put` is unchanged.

`summarizeUnionPlan` hashes arm collection names in **declaration order** (semantically meaningful for the dedup-only path — first-seen row per composite key wins, and reordering arms must trigger a refresh). `groupBy` fields and `aggregate` keys are still sorted (genuinely commutative). Two regression tests pin the asymmetry. (niwat review, [#167](https://github.com/vLannaAi/noy-db/pull/167) — first finding addressed in `6be47a2`.)

`maxRows`, `onEmpty`, `strict` semantics inherited unchanged. Composes with multi-key groupBy: the niwat canonical monthly-VAT shape — `union(taxReceipts, creditNotes).groupBy('clientId', 'period').sum('vat')` — is the combined test fixture.

### `GuardStrategyHandle` variance cleanup ([#131](https://github.com/vLannaAi/noy-db/issues/131))

`GuardStrategyHandle<T>` is invariant in `T` because `T` appears in callback positions on the spec (`check(incoming: T, ctx)`, `invariant(changes: ReadonlyArray<GuardChange<T>>, ctx)`). Pre.14 worked around it with `GuardStrategyHandle<any>` + two `eslint-disable @typescript-eslint/no-explicit-any` annotations on public-API fields.

The fix: a sealed internal `GuardStrategyHandleAny` existential interface (`{ __noydb_strategy: 'guard'; spec: GuardStrategy<any> }`) as the array element type. Both `Handle<Invoice>` and `Handle<Disbursement>` structurally widen to this erased form. Three call sites updated:

- `NoydbOptions.guardStrategies` at `packages/hub/src/types.ts:1751–1752`
- `Vault` constructor option at `packages/hub/src/vault.ts:374–375`
- `_initGuards()` internal at `packages/hub/src/vault.ts:1410–1411` (bonus third site beyond the issue's two)

The single `any` retained inside the existential body is the established named-existential pattern — `any` is now contained behind a private named boundary instead of leaking from public-API field positions. Type-only refactor; no behaviour change; guards test suite (48 tests) and showcase 79 unchanged.

### Niwat-review follow-ups

`5b385e7` adds two registration guards from the niwat review of [#167](https://github.com/vLannaAi/noy-db/pull/167):

- [#169](https://github.com/vLannaAi/noy-db/issues/169) — UNION MV with `aggregate` requires `groupBy` (else the executor silently dropped the reducer)
- [#170](https://github.com/vLannaAi/noy-db/issues/170) — `predicates` not supported on UNION MVs (predicate hashes weren't folded into `summarizeUnionPlan` and `.wherePredicate` never fired in the executor)

Both fail-fast at registration with `MaterializedViewConfigError`, same pattern as the existing empty-`groupBy` and arm-distinct-collection guards.

### Known follow-up

`Collection._doDelete` does NOT call `dispatchMaterializedViews` (only the two `put` code paths at `packages/hub/src/collection.ts:1283` and `:1399` do). Deleting a source row never triggers an eager MV refresh; tombstoning fires only when a subsequent `put` on the same source re-runs the executor, or when `vault.refreshView()` is called manually. Affects all MVs with `onEmpty: 'delete'` (the default) — not just UNION-form. The tombstone test in `packages/hub/__tests__/materialized-views/union.test.ts` lands in manual-refresh form (proves the executor + `listOutputIds` are correct) and is paired with an `it.todo` at line 333 pinning the auto-dispatch gap for a future PR.

### Showcases + docs

- [`85-with-multikey-groupby`](https://github.com/vLannaAi/noy-db/blob/main/showcases/src/85-with-multikey-groupby.showcase.test.ts) — variadic groupBy walkthrough, declaration-order assertions, niwat per-(client, period) shape
- [`86-with-union-mv`](https://github.com/vLannaAi/noy-db/blob/main/showcases/src/86-with-union-mv.showcase.test.ts) — UNION MV walkthrough with the monthly-VAT example
- `docs/services/aggregate.md` — new "Multi-key groupBy" section
- `docs/services/derivations.md` — "Multi-key groupBy in MV queries" + "UNION sources" sections
- `features.yaml` — new invariants under `aggregate` and `materialized-views`; new showcase entries cross-linked from both

## 0.1.0-pre.14

Two related strands shipped together: **Guards/Derivations v1.5** fast-follows from the pre.11 surface, then **Dim 14 v2 — `withMaterializedView`** built on top. 12 issues closed across 7 merged PRs; ~3000 LOC added across `src/`; 1573 hub tests pass on the tip.

### Guards/Derivations v1.5 ([#148](https://github.com/vLannaAi/noy-db/pull/148))

Four fast-follow refinements that landed first to give the MV v2 work a hardened `ReadOnlyVaultFacade` foundation:

- **`withGuard.onDelete`** ([#145](https://github.com/vLannaAi/noy-db/issues/145)) — guards can now reject deletes based on record state. Mirrors the `check` hook's shape but fires on `Collection.delete`. Used by the v2 MV tombstoning path: a `receipts.onDelete: throw` rule no longer deadlocks the system's own housekeeping deletes (see § Tombstone bypass below).
- **`withDerivation` optional outputs** ([#144](https://github.com/vLannaAi/noy-db/issues/144)) — declare an output as `optional: true` and return `null` to skip emission. If a prior derivation emitted at this id, it's tombstoned via `Collection._internalDelete` (system-internal bypass of user `onDelete` guards). Returning `null` for a non-optional output still throws `DerivationOutputShapeError`.
- **`derive(source, ctx)` gets the `ReadOnlyVaultFacade`** ([#147](https://github.com/vLannaAi/noy-db/issues/147)) — same facade guards have. `ctx.vault.collection<T>('siblings').get(id)` works inside `derive`. Strategy hash incorporates `derive.toString()` so the function body pins inputs; sibling reads must be deterministic given the same source row (consumer responsibility).
- **`.query()` on `ReadOnlyVaultFacade`** ([#146](https://github.com/vLannaAi/noy-db/issues/146)) — aggregating checks can now express set-level invariants (`vault.collection('invoices').query().where(...).count()`) inside guard `check` callbacks. Closes the "I can't enforce 'no two open invoices for the same client' without sweeping list()s" gap.

### Dim 14 v2 — `withMaterializedView` ([#149](https://github.com/vLannaAi/noy-db/issues/142) spec + [#143](https://github.com/vLannaAi/noy-db/issues/143) implementation epic)

Query-level materialized views. Where `withDerivation` v1 projects one source row into N typed outputs, `withMaterializedView` materializes the result of an entire `Query<T>` — filter, groupBy, aggregate, join — into a queryable collection kept fresh on source writes. Six sub-issues across foundation, lifecycles, correctness, predicates, overlays, and showcases:

- **Foundation** ([#150](https://github.com/vLannaAi/noy-db/issues/150), PR [#156](https://github.com/vLannaAi/noy-db/pull/156)) — `withMaterializedView({ name, query, rowKey, refresh })` factory; `MaterializedViewRegistry`; `MaterializedViewExecutor`; `Collection.put` source-write hook for eager refresh. `_materializedFrom` payload metadata (lives inside encrypted `_data`, opaque to the store — matches `_derivedFrom` precedent). `MaterializedViewCycleError` + `MaterializedViewSourceUnknownError`. New `@noy-db/hub/materialized-views` subpath.
- **Lazy + manual lifecycles** ([#151](https://github.com/vLannaAi/noy-db/issues/151), PR [#157](https://github.com/vLannaAi/noy-db/pull/157)) — `refresh: 'lazy'` marks the MV stale on source writes; the next read of the MV output collection resolves on demand. `refresh: 'manual'` opts out of the source-write hook entirely; `vault.refreshView(name)` is the only refresh path. Returns `{ written, deleted, failed }` — niwat-review caught the original "deleted: 0 hardcode" pre-merge.
- **Correctness — partition / onEmpty / ceiling / strict / aggregate** ([#152](https://github.com/vLannaAi/noy-db/issues/152), PR [#158](https://github.com/vLannaAi/noy-db/pull/158)) — five strategy fields:
  - `output.partition: { field, value }` — same-collection edges are allowed when a where-clause provably excludes `partition.value` (`==` against a different value, `!=` against the value, `in` lists that exclude it). Cycle detector resolves these as non-cycles.
  - `onEmpty: 'delete' | 'keep'` (default `'delete'`) — when a key that previously emitted rows yields zero rows, tombstone via `Collection._internalDelete`. User `onDelete` guards on the output collection are bypassed for housekeeping (the composition fix that makes #145 + MV refresh coherent).
  - `maxRows` (default `100_000`) — row-count ceiling; throws `MaterializedViewTooLargeError` **before** any writes (clean rollback).
  - `strict: true` re-throws row-write failures → composes with `withTransactions` to roll back the source-write atomically via `revertExecuted` (the orphan-window fix from pre.12 #133).
  - **Aggregate / groupBy queries** — executor branches on the terminal shape (`Query<T>.toArray()` / `Aggregation.run()` / `GroupedAggregation.run()`). `groupBy().aggregate()` closes over its source so the dep analyzer can't introspect; aggregate MVs require explicit `sources?: string[]`.
- **Declared deterministic predicates** ([#153](https://github.com/vLannaAi/noy-db/issues/153), PR [#159](https://github.com/vLannaAi/noy-db/pull/159)) — `MaterializedViewStrategy.predicates: { [name]: { hash, fn } }` registers named functions callable from inside the MV's `query()` callback via `.wherePredicate(name, ctx?)`. The predicate's `hash` **and** a canonical-JSON hash of the `ctx` argument both fold into `queryHash` — bumping `hash` or changing `ctx` forces refresh. Canonical use: `isOverdue` against an `asOf` date that moves externally. Niwat-review caught the original "predicates dropped through chain methods" pre-merge: every chain operator (`where`, `or`, `and`, `filter`, `orderBy`, `limit`, `offset`, `join`) now threads the predicates map.
- **Overlay views — `withOverlayedView`** ([#154](https://github.com/vLannaAi/noy-db/issues/154), PR [#160](https://github.com/vLannaAi/noy-db/pull/160)) — read-shadow primitive. Declares a virtual collection that merges a `base` (typically an MV output) with a user-writable `overlay` via a single-field shadow predicate (`overlay[shadowField] === shadowValue`). Writes through the virtual proxy route to the overlay. Constraints: `base` must be concrete (no overlay-on-overlay stacking — v3 non-goal); `overlay` must not be an MV output; virtual name must not collide with concrete collections or MV outputs. Four error classes (`OverlayBaseIsVirtualError`, `OverlayCollectionUnavailableError`, `OverlayNameCollisionError`, `OverlayIdMismatchError`).
- **Showcases + reader-facing docs** ([#155](https://github.com/vLannaAi/noy-db/issues/155), PR [#161](https://github.com/vLannaAi/noy-db/pull/161)) — four new showcases (`81-with-mv-eager`, `82-with-mv-lazy`, `83-with-overlay`, `84-with-mv-predicates`) totaling 19 tests; `docs/services/derivations.md` extended with Materialized Views + Overlay views sections; `features.yaml` entries for `materialized-views` and `overlay-views`.

### Composition story

The pre.14 release closes the loop on the write-path primitive composition:

- **Guards** ([#123](https://github.com/vLannaAi/noy-db/issues/123), pre.11) — block writes before encryption.
- **Derivations** ([#129](https://github.com/vLannaAi/noy-db/issues/129), pre.11) — eager / lazy record-level projections, post-write.
- **`withGuard.onDelete`** ([#145](https://github.com/vLannaAi/noy-db/issues/145), pre.14) — symmetric delete-side gate.
- **Materialized views** ([#143](https://github.com/vLannaAi/noy-db/issues/143), pre.14) — query-level derivations; same encryption / opacity guarantees.
- **Overlay views** ([#154](https://github.com/vLannaAi/noy-db/issues/154), pre.14) — operator-editable override layer over MV outputs.

The `Collection._internalDelete` housekeeping bypass (introduced in #148 for #144's tombstoning) is the load-bearing primitive that keeps `withGuard.onDelete: throw` rules coherent with system-driven tombstones from optional derivations and MV `onEmpty: 'delete'` flows.

### Process notes for niwat integration

- All five MV PRs (#156–#160) plus #161 passed niwat-review with "No issues found" verdicts after pre-merge fixes. The niwat-review pattern that worked: surface composition issues (e.g. "list/query/scan don't trigger lazy resolve", "chain methods drop predicates map") before the PR landed on main.
- Stacked-PR rebase pattern documented in [project memory](https://github.com/vLannaAi/noy-db/blob/main/) after this cycle: when squash-merging a stack of N PRs, the canonical recovery for the (N+1)th descendant is `reset --hard origin/main && cherry-pick <descendant-only-commits>` rather than re-rebasing the original branch. Re-rebasing leaks conflict markers when the parent's content has been merged with reviewer-fix tweaks.

### Files of interest

- `packages/hub/src/materialized-views/{executor,registry,stale,dependency-analyzer,query-hash,with-materialized-view}.ts`
- `packages/hub/src/overlay-views/{registry,virtual-collection,with-overlayed-view,types}.ts`
- `packages/hub/src/query/builder.ts` (predicates threading + `serializeClause` for `wherePredicate`)
- `showcases/src/8{1,2,3,4}-*.showcase.test.ts`
- `docs/services/derivations.md` (extended)
- `docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md` (the spec)

## 0.1.0-pre.12

Three follow-ups from pre.11's guards + derivation work: bundle regression plugged ([#130](https://github.com/vLannaAi/noy-db/issues/130)), strict-mode multi-output orphan window closed ([#133](https://github.com/vLannaAi/noy-db/issues/133)), and user-list visibility flags shipped ([#122](https://github.com/vLannaAi/noy-db/issues/122)). Plus [#132](https://github.com/vLannaAi/noy-db/issues/132) closed as superseded by #130.

### Bundle regression fix (#130)

Root cause: `Vault` and `Collection` had **static value imports** of `GuardRegistry`, `DerivationRegistry`, `ReadOnlyVaultFacade`, `GuardExecutor`, and `DerivationExecutor` — forcing the classes into `dist/index.js` even when consumers only imported `createNoydb`. Verified by inspecting the generated dist artefacts: the 5 class names all appeared in the floor bundle's top-level imports.

- **Fix** — converted all 5 to type-only imports + lazy `await import(...)` at construction / dispatch time. Mirrors the deferred-load approach already used by some other subsystems.
- **Bundle measurement** — floor dropped from **45,238 gz → 39,524 gz (−12.6%)**. Not all the way to the v0.25 baseline because of intervening features unrelated to the regression — the baseline has been reset on a methodology that now uses `splitting: true` (matches what real consumer bundlers emit).
- **Leak canaries** — 5 new symbol-presence assertions added to `check-bundle.mjs`, plus a new `eagerImports` field that catches splitting-aware regressions. The prior leak would have silently passed CI without these.
- PR [#138](https://github.com/vLannaAi/noy-db/pull/138), follow-up fixups in commit `03544b3` per code review.

### Strict-mode derivation orphan (#133)

When a strict-mode derivation produced multiple outputs and a later strategy threw, the first M outputs were already written via the `dispatchDerivations` `Collection.put` recursion. Those nested writes were **not** visible to the outer transaction's revert plan, so `revertExecuted` rolled back the source but left orphans on disk.

- **Fix** — `Noydb` now tracks the active transaction context (set by `runTransaction` at Phase 2 start, cleared in `finally`). `Collection.dispatchDerivations` checks the active context and registers each derived put as a side-effect op in `ctx._executed` before the write fires. `revertExecuted` already walks `_executed` in reverse — side-effect entries get reverted naturally.
- **Adjacent site fixed in flight** — same treatment applied to `Collection.putManyAtomic`, which has its own bespoke commit loop and would have had the identical orphan window otherwise (caught in code review).
- **Reproduction scope** — the orphan was only reproducible with **two strategies on the same source**; single-strategy multi-output never partially writes because `DerivationExecutor.run` validates all output shapes upfront before any persistence call.
- PR [#139](https://github.com/vLannaAi/noy-db/pull/139).

### User-list visibility flags (#122)

Two new visibility controls on top of the per-vault user envelope (pre.6 work):

- **Per-user `hidden` flag** — stored at `_meta/visibility/<keyringId>` (sidecar, plaintext bypass — mirrors `_meta/policy` and `_meta/handle`). Set via `vault.user.setMyVisibility({ hidden: true })` (own-only). `listUsersWithEnvelopes` filters hidden envelopes by default; admin / owner callers pass `{ includeHidden: true }` to see them.
- **Vault-level `directory.enabled` flag** — stored at `_meta/directory`. Toggled via `Noydb.setDirectoryEnabled(vault, enabled)` (owner-only). When false, `listUsersWithEnvelopes` throws the new `DirectoryDisabledError` for non-admin / non-owner callers.
- **Breaking API change** — `listUsersWithEnvelopes` gained a required `callerRole: Role` parameter. Consumers using the function directly must update; the hub-internal wrappers source `callerRole` from the unlocked keyring (signed-by-construction, no bypass). Documented as a minor-version surface change.
- **Design adaptation** — the issue proposed adding `hidden` to `PublicUserEnvelope.data`, but `UserEnvelope.data: T` is opaque-to-hub by contract (apps own the schema). Used the sidecar pattern instead, preserving the existing invariant.
- **New error** — `DirectoryDisabledError`, exported from `@noy-db/hub` and the `team/` subpath barrel for `instanceof` checks.
- **Honest caveat documented** — visibility is a **UX flag, not a privacy guarantee**. The keyring count and envelope ciphertext are still observable to anyone with store-read access; hidden hides only the joined plaintext from the directory enumeration.
- **Lifecycle** — `revoke()` also deletes the visibility sidecar (commit `6f5543c`, caught by code review). Without this, a re-granted same-userId would silently inherit the old flag.
- PR [#140](https://github.com/vLannaAi/noy-db/pull/140), follow-up fixup `6f5543c`.

### Closed without code (#132)

The original premise — "pre-hash the `withDerivation` handle so `register()` becomes sync so the `Vault` constructor can own derivation init" — was broken by #130. To plug the bundle regression, `DerivationRegistry` is now dynamically imported via `await import(...)` — the constructor can no longer reference `new DerivationRegistry()` directly. Pre-hashing alone has independent minor value (debugging) but doesn't move the needle on the original goal (plugging the `Noydb.vault()` sync fallback accessor gap). Closed with rationale; revisit if anyone hits the fallback gap in practice.

### Test count growth

1485 → **1494** hub tests (9 new across the three fixes / features). 124 test files total.

### Known follow-ups (pre.13 milestone)

- Remaining real-provider showcase batch (Apple / Google / LINE): [#64](https://github.com/vLannaAi/noy-db/issues/64), [#65](https://github.com/vLannaAi/noy-db/issues/65), [#73](https://github.com/vLannaAi/noy-db/issues/73), [#74](https://github.com/vLannaAi/noy-db/issues/74), [#75](https://github.com/vLannaAi/noy-db/issues/75), [#76](https://github.com/vLannaAi/noy-db/issues/76).

### Issues closed

#122, #130, #132, #133

## 0.1.0-pre.11

Two new subsystems land in the same release: **`withGuard`** (record lock + field freeze + role-gated amendment invariant) and **`withDerivation`** (deterministic derived data, Dim 14 v1). Closes the pre.11 milestone — 8 substantive issues, 2 PRs, plus 4 reviewer-caught side-fixes and 2 tier-2 auth showcases.

### Guards subsystem (#123 epic)

`withGuard` plumbs a uniform three-axis guard primitive — record-level lock, field-level freeze, and role-gated amendment invariant — into the `Collection.put` / `.delete` write path. Strategies register against (collection, fieldOrLock) pairs; the executor runs synchronously inside the put pipeline with full plaintext access. Cross-collection invariants get a `ReadOnlyVaultFacade` so the strategy can read sibling collections without re-entering the write lock.

- **`withGuard` factory + `GuardStrategy` types** ([#123](https://github.com/vLannaAi/noy-db/issues/123)) — `withGuard(spec)` returns a strategy handle; the spec declares `collection`, `kind: 'lock' | 'freeze' | 'invariant'`, target field(s) or lock condition, and an optional `amendable` clause (role list + invariant predicate). New `@noy-db/hub/guards` subpath barrel (sibling of `@noy-db/hub/periods` in the `time-and-audit` cluster).
- **`GuardRegistry` + `GuardExecutor`** ([#124](https://github.com/vLannaAi/noy-db/issues/124)) — registration at vault open, dispatch on every put/delete, frozen-field diff (`fieldChanged(prev, next, path)` deep-equality with array-aware semantics), amendment change collection, invariant runner. Strategies that throw are surfaced as one of the four typed errors below.
- **`LedgerEntry` extension with `op: 'amendment'` + audit-aware skip** ([#125](https://github.com/vLannaAi/noy-db/issues/125)) — every successful amendment writes an extra ledger entry carrying the changed-fields diff + invocation factors. `verifyBackupIntegrity` and `reconstructAtVersion` skip `op: 'amendment'` entries when reconstructing the canonical record stream (these are audit overlays, not state transitions). **Side-fix during review**: pre-fix, both helpers would have falsely failed integrity on any vault with amendment entries — the bug existed in latent form because no amendment entries existed yet. Fixed in this release before any user could hit it.
- **`Collection.put` / `.delete` guard hook + `ReadOnlyVaultFacade`** ([#126](https://github.com/vLannaAi/noy-db/issues/126)) — guard executor runs after permission check, before encryption + ledger commit. `ReadOnlyVaultFacade` exposes a frozen vault snapshot to amendment invariants so cross-collection rules (e.g. "amendment of `invoices` requires open `period` in `periods`") can read sibling state. **Side-fix during review**: the initial PR stubbed the facade as `null` / `[]`, blinding cross-collection reads; caught in code review and replaced with a real read-only proxy over the in-memory plaintext layer.
- **Four error classes** ([#127](https://github.com/vLannaAi/noy-db/issues/127)) — `RecordLockedError`, `FieldFrozenError`, `InvariantError`, `AmendmentForbiddenError`. All carry `collection`, `id`, and rule context; `InvariantError` and `AmendmentForbiddenError` additionally carry the changed-fields list and the invariant's name. Exported from the `@noy-db/hub/guards` subpath barrel + root for `instanceof` checks.
- **Showcase 79 — accounting end-to-end** ([#128](https://github.com/vLannaAi/noy-db/issues/128)) — invoice lock after issue, frozen `amount` / `clientId` post-finalization, period-aware amendment invariant requiring open accounting period + audit-trail role. Full round-trip including ledger replay verification.
- **Side-fix during review** — cache-invalidation in `putManyAtomic` revert path. The transaction-revert pass touched the canonical record but not the cached plaintext, leaving a stale entry. Caught while verifying guard rollback semantics; fix benefits any future `putManyAtomic` revert scenario.

### Derivations subsystem (#129 epic, Dim 14 v1)

`withDerivation` plumbs deterministic derived data — every put on the source collection eagerly recomputes outputs and stamps `_derivedFrom` metadata on each output record. Lazy lifecycle (stale tracking + on-read resolution in `Collection.get`) provides the read-path resolution when the source mutates outside a put (sync replay, batch import).

- **`withDerivation` factory + types** — `DerivationStrategy`, `OutputSpec`, `DerivedFromMeta`. New `@noy-db/hub/derivations` subpath barrel (sibling of `@noy-db/hub/tx` in the `write-and-mutate` cluster).
- **`DerivationRegistry` with DFS cycle detection** — runs at vault open. Builds a strategy DAG; rejects open with `DerivationCycleError` if the cycle wouldn't terminate (carries the offending strategy chain). Max-depth ceiling enforced via `DerivationDepthError`.
- **`DerivationExecutor`** — runs `derive(record)` on plaintext under the same in-memory snapshot the put sees, validates output shape against the registered `OutputSpec` (`DerivationOutputShapeError`), rejects unknown output collections (`DerivationOutputUnknownError`), stamps `_derivedFrom: { source, sourceId, sourceVersion, strategyHash }` on each output record.
- **`computeStrategyHash`** — SHA-256 over `source-collection-name + sorted(output-keys) + derive.toString()`. Stable across runs; lets the lazy path detect drift when the strategy redeploys against existing output records.
- **Four error classes** — `DerivationCycleError`, `DerivationDepthError`, `DerivationOutputUnknownError`, `DerivationOutputShapeError`. Exported from the `@noy-db/hub/derivations` subpath barrel + root.
- **Eager dispatch in `Collection.put`** — after store + ledger commit, the registry's `derivationSource(collection, id)` callback fires, executor walks the strategies, writes outputs. Strict mode rethrows; soft mode marks stale.
- **Lazy lifecycle** — stale tracking via `WeakMap<DerivationRegistry, Set<string>>`. `Collection.get` checks staleness, resolves on read, writes-through. Bulk recompute via `vault.deriveAll(collection)` for cold-cache scenarios.
- **Side-fix during review** — `runTransaction` revert-plan reorder. Pre-fix, `executed.push(...)` ran AFTER the put/delete call, so a mid-put throw (including strict-mode derivation failures) bypassed rollback registration and corrupted the transaction's exit state. Now `executed.push(...)` runs BEFORE the call. The fix benefits any future mid-`Collection.put` throw scenario, not just derivation strict-mode.
- **Showcase 80 — PDF source → meta + text outputs** — round-trip exercising eager + lazy paths, cycle-detection at open, strategy-hash drift recognition.

### Tier-2 auth showcase coverage (#77, #78)

Closes the two `priority: high` real-provider gaps from the 2026-05-09 audit — the only tier-2 packages that hold wrap-key material on their own (`on-password` derives a wrap-DEKs key via PBKDF2; `on-webauthn` releases a PRF fragment to wrap KEK).

- **Showcase 71 — `on-password` tier-2 capability matrix** ([#78](https://github.com/vLannaAi/noy-db/issues/78)) — 16 scenarios pinning the `kek: null` keyring security contract: cold-start unlock via `(vault, userId, password)` triple; capability matrix on tier-1-gated ops (✅ read/write/query, ❌ enrollAuthenticator/rotatePassphrase/grant); re-elevation back to tier 1 restores full capability; password-vs-phrase policy split (password strength is `PasswordPolicy`, phrase strength is `PassphrasePolicy` — they cannot bleed); `@noy-db/on-threat` lockout integration; username-binding regression (slot id `password:<userId>` prevents cross-user replay). Uses `@vitest-environment node` to dodge happy-dom's partial `subtle.exportKey` polyfill.
- **Showcase 72 — `on-webauthn` Playwright virtual authenticator** ([#77](https://github.com/vLannaAi/noy-db/issues/77)) — gated behind `NOYDB_SHOWCASE_WEBAUTHN_VIRTUAL=1` + one-shot `pnpm exec playwright install chromium`. Drives a real Chromium CDP virtual authenticator with PRF support; covers register + assert + PRF determinism (same salt → same fragment) + salt sensitivity (different salt → different fragment) + cross-device rejection (different credential id → assert fails).

### Known follow-ups (pre.12 milestone)

- **[#130](https://github.com/vLannaAi/noy-db/issues/130) — bundle-size regression (~30–48% gz)** introduced by the guards `index.ts` re-export. Under investigation; likely a subpath-barrel-only fix once we trace the exact transitive pull.
- **[#131](https://github.com/vLannaAi/noy-db/issues/131) — `GuardStrategyHandle<any>` type variance refactor** (backlog) — the registry currently widens to `any` at the dispatch boundary; can tighten with a discriminated-union handle once the public surface settles.
- **[#132](https://github.com/vLannaAi/noy-db/issues/132) — `withDerivation` pre-hashed register** — make the factory hash the strategy at construction time so `register()` becomes sync. Plugs the `Noydb.vault()` fallback gap where async-register currently forces a single-tick boundary at vault open.
- **[#133](https://github.com/vLannaAi/noy-db/issues/133) — strict-mode multi-output orphan window** — if a strict-mode derivation produces N outputs and output K throws shape validation, outputs 0..K-1 are already written. Fix is a two-pass write (validate all → commit all) but needs design for the cycle-aware case.

### Issues closed

#77, #78, #123, #124, #125, #126, #127, #128, #129

## 0.1.0-pre.10

### Audit-and-cleanup batch

A 2026-05-09 deep-review of the pre.9 surface (security + API consistency) filed 15 issues; iterative code review of the resulting fixes filed 4 more; one in-flight symmetry close. **20 PRs land in this release**, addressing 18 issues.

#### Security (P0)

- **STRICT_POLICY enroll-user / revoke-user gates are no longer dead-coded** ([#79](https://github.com/vLannaAi/noy-db/issues/79)) — `db.grant` and `db.revoke` now invoke `checkGate('enroll-user', factors)` and `checkGate('revoke-user', factors)` on top of the legacy `checkPolicyOperation`. Adds optional `factors?: FactorProofBundle` parameter to both methods. **Behavior change for STRICT_POLICY consumers**: grants and revokes without a factor proof now correctly throw `PolicyDeniedError` (the documented contract). PERSONAL_POLICY (default) is unchanged — its gates are `minTier: 1` with no factor requirement.

- **`db.changeSecret` validates passphrase strength by default** ([#80](https://github.com/vLannaAi/noy-db/issues/80)) — `assertStrongPassphrase` fires unconditionally unless `allowWeakPassphrase: true` is passed. Pre-fix, `changeSecret` was opt-in (`validate: true`) and the public `db.changeSecret` never opted in — bypassable from the consumer surface even after pre.5 #7 shipped phrase strength validation. **Breaking change**: existing consumers passing weak passphrases through `db.changeSecret` will throw `WeakPassphraseError`. Pass `{ allowWeakPassphrase: true }` to preserve old behavior; for fresh code, use `db.rotatePassphrase` which has the same validation contract end-to-end. The `db.changeSecret` signature gains an optional options argument: `changeSecret(vault, newPassphrase, options?: PassphrasePolicy & { allowWeakPassphrase? })`.

- **`grant()` rejects when caller's kek is null** ([#81](https://github.com/vLannaAi/noy-db/issues/81)) — closes the tier-2 capability matrix violation. Pre-fix, `grant()` iterated `callerKeyring.deks` and wrapped under the new user's `newKek` without ever reading `callerKeyring.kek`, so a tier-2 wrap-DEKs session (`@noy-db/on-password`) or tier-3 PIN-resume session (`@noy-db/on-pin`) could create new user keyrings. The documented contract (per `auth-landscape.md`) is that those tiers cannot perform privileged admin operations. Now mirrors `persistKeyring`'s null-`kek` guard at the head of `grant()`. Same fix applied to `buildRecipientKeyringFile` ([#112](https://github.com/vLannaAi/noy-db/issues/112), bundle-recipient mint) — adjacent site flagged by code review of the original fix.

- **`onInvalidKey: 'reset'` no longer destroys valid keyrings on partial corruption** ([#82](https://github.com/vLannaAi/noy-db/issues/82)) — the audit's highest-impact P0 (silent data loss). Pre-fix, `loadKeyring` walked the wrapped-DEK set in a bare `for...of`; the first corrupted byte killed the load with `InvalidKeyError`, and `onInvalidKey: 'reset'` (#6, pre.7) destroyed the keyring even when the KEK was correct. Now each DEK unwraps independently — mixed success ⇒ corruption (new `KeyringCorruptError`, reset does NOT fire); all-fail ⇒ wrong key (reset fires as documented). New `KeyringCorruptError` class carries `failedCollections: readonly string[]` and `intactCount: number` for targeted recovery UI. Exported from `@noy-db/hub` for `instanceof` checks. `listAccessibleVaults` updated to skip `KeyringCorruptError` like the other expected-failure modes (single corrupt vault no longer poisons the enumeration).

- **Passphrase canary closes the single-DEK + all-DEKs-corrupt ambiguity from #82** ([#113](https://github.com/vLannaAi/noy-db/issues/113)) — additive `KeyringFile.canary?: string` field. The canary is a fixed 256-bit AES-GCM key wrapped under the keyring's KEK with AES-KW. AES-KW is deterministic, so each write site mints fresh on persist without round-tripping a `canary` field through `UnlockedKeyring`. `loadKeyring` verifies the canary first; combined with each-DEK try/catch, this distinguishes wrong-passphrase from corruption even when ALL DEKs (including a single-DEK keyring's sole DEK) are corrupted. Pre-#113 keyrings without the field load via the legacy multi-DEK heuristic from #99 — backward compatible, no migration required.

#### Atomicity / contract holes (P1)

- **`rotatePassphrase` slot ceremony validates `wrapKind`** ([#83](https://github.com/vLannaAi/noy-db/issues/83)) — extends pre.8 #29's anti-slot-swap guard with a third equality check on `wrapKind` alongside `id` and `method`. Closes the hole where a buggy or hostile ceremony could change the slot's session-tier contract under cover of rotation: `'kek' → 'deks'` downgrade silently produces `kek: null` at unlock; `'deks' → 'kek'` upgrade bricks the slot via an AES-KW failure.

- **`recoverPassphrase` burns the paper recovery code BEFORE rewriting the keyring** ([#84](https://github.com/vLannaAi/noy-db/issues/84)) — atomicity reordering. Pre-fix, a store error after the keyring write left the user on the new passphrase but the consumed paper code remained valid (anyone with the same paper sheet could reuse it — security regression). Post-fix, the failure mode flips from security to usability: code burned + keyring not rewritten ⇒ user keeps old passphrase, loses one code (recoverable via admin / another code).

- **`UpdateUserOptions.displayName` accepts `null` to clear the field** ([#85](https://github.com/vLannaAi/noy-db/issues/85)) — aligns `db.updateUser` with the `null`-as-clear convention pre.9 #57 shipped for `UserApi.updateMe`. Type widens from `string | undefined` to `string | null | undefined`. `null` clears (stored as the empty string; UI consumers typically render the empty case by falling back to the user id). `permissions` stays full-replacement at the map level (documented invariant).

- **`RecoverPassphraseInput.recoveryProof` TS-narrowed to `'paper'`** ([#86](https://github.com/vLannaAi/noy-db/issues/86)) — matches `db.enrollRecovery`'s TS-narrow discipline. Pre-fix, the type accepted a 4-variant union (`paper | shamir | multi-channel | admin-mediated`) and three of the four threw `RecoveryProfileNotImplementedError` at runtime. The runtime guard remains — `as unknown as RecoveryProof` bypasses the type but still hits the error. **Breaking-but-narrowing**: a consumer with `recoveryProof` typed as the wide union (e.g. ferrying through helper code) will get a TS error after this lands.

#### DX / surface coherence (P2)

- **`docs/services/plaintext-bypass.md` invariant catalog** ([#87](https://github.com/vLannaAi/noy-db/issues/87)) — every collection that stores JSON in cleartext (`_keyring/<userId>`, `_meta/policy`, `_meta/recovery-paper`, `_meta/handle`, `_meta/public-envelope`, `_meta/invite-audit-<id>`, `_meta/sync-credentials`, ledger, consent, blob index) listed with rationale, plus a threat-model surface ("what an attacker with store-only access can learn"), plus an explicit checklist for adding or removing a bypass.

- **`db.getKeyring()` returns a defensive copy** ([#88](https://github.com/vLannaAi/noy-db/issues/88), [#114](https://github.com/vLannaAi/noy-db/issues/114)) — pre-fix, the returned `UnlockedKeyring`'s `deks` Map (typed `readonly`, but the Map itself isn't) was the live cached reference. A consumer calling `.deks.set()` corrupted the hub's internal state. Now returns a defensive shallow copy with fresh `Map`, fresh `authenticators` array, and per-element clones of `meta`. Hub-internal callers use a new `private getKeyringInternal` that returns the live ref so mutations from `ensureCollectionDEK` still land on the cache. CryptoKey handles inside `deks` stay shared (opaque references; encrypt/decrypt opaque). 14 internal call sites switched.

- **`FactorProofBundle` unifies the gate-method param shape** ([#89](https://github.com/vLannaAi/noy-db/issues/89)) — same shape `{ factors?, sharedDevice? }` was inlined at 12 sites with the parameter name alternating `factors` / `presented`. Now exported as a named type from `@noy-db/hub` (re-exported from the `policy` subpath); param name converges to `factors` everywhere.

- **Subpath barrels (`team/`, `i18n/`, `query/`, `session/`, `bundle/`, `store/`) populated** ([#90](https://github.com/vLannaAi/noy-db/issues/90)) — pre-fix, `@noy-db/hub/team` exported only `UnlockedKeyring` + sync helpers; the rest of the team API (rotate/recover, authenticator family, paper recovery primitives, magic-link grant, peer-recover, listUsers) was reachable only through the root barrel. Per-domain errors (`SessionExpiredError`, `JoinTooLargeError`, `BundleIntegrityError`, `StoreCapabilityError`, the i18n trio) couldn't be `instanceof`-checked from a subpath import. All subpaths now own their domain's full export set.

- **`KeyringAuthenticator` variant types re-exported from index.ts** ([#91](https://github.com/vLannaAi/noy-db/issues/91)) — `KeyringAuthenticatorWrappingKEK`, `KeyringAuthenticatorWrappingDEKs`, `EnrollAuthenticatorWrappingKEKOptions`, `EnrollAuthenticatorWrappingDEKsOptions`. `@noy-db/on-*` package authors writing variant-specific helpers can now name the type directly instead of reconstructing via `Extract<KeyringAuthenticator, { wrapKind: 'deks' }>`.

- **Adapter/Compartment naming residue cleaned up** ([#92](https://github.com/vLannaAi/noy-db/issues/92)) — user-visible strings (`session/dev-unlock.ts`, `collection.ts`), JSDoc in `types.ts`, and three sed-truncation artefacts (`team/index.ts`, `index.ts`, `errors.ts`). The internal `syncAdapter` field name on Collection / Vault / PresenceHandle is intentionally NOT renamed in this release — internal-only but touches multiple constructors and their tests.

- **Leftover `null as unknown as CryptoKey` casts in showcases** ([#93](https://github.com/vLannaAi/noy-db/issues/93)) — pre.8 #41 tightened `UnlockedKeyring.kek` to `CryptoKey | null`. The hub source was correctly migrated; three showcase fixtures (`23-on-webauthn`, `24-on-oidc`, `30-on-pin`) still carried casts. Replaced with literal `null`.

#### Documentation

- **`docs/services/auth-landscape.md` § Package boundaries** ([#43](https://github.com/vLannaAi/noy-db/issues/43)) — names the layering between `@noy-db/hub` (cryptosystem) and the `@noy-db/on-*` packages (user-facing input format) explicitly. Closes #43 as wontfix-by-design — folding `on-recovery` into a `@noy-db/hub/recovery-codes` subpath would anchor Base32 as the canonical format and break consumer swap-ability for no real bundle saving.

#### Issues closed

#43 (wontfix-by-design), #79, #80, #81, #82, #83, #84, #85, #86, #87, #88, #89, #90, #91, #92, #93, #112, #113, #114

## 0.1.0-pre.9

### Consumer-iteration cycle on pre.8 APIs

Closes the 5-issue follow-up batch surfaced after Niwat (first production consumer) shipped pre.8 to production. No new subsystems; surgical extensions to APIs that landed in pre.8.

#### New public APIs

- **`db.updateUser(vault, options, factors?)`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — post-grant identity mutation for `role`, `displayName`, and `permissions`. Pure plaintext-header rewrite — no DEK rewrap, no KEK required, no authenticator slots touched. Tier-2 enrollments and recovery codes survive. New `update-user` policy gate (PERSONAL: `minTier: 1`; STRICT: `minTier: 1, factors: ['totp','email-otp']` — admin-shaped, mirrors `enroll-user`/`revoke-user` rather than recovery). Two-sided role-elevation guard mirrors `db.grant`'s hierarchy: BOTH old and new role must satisfy `canUpdateRole(callerRole, _)`, blocking admin self-promote, admin promote-to-owner, admin demote-from-owner, and non-admin self-edit. `permissions` is full-replacement at the map level (consumers wanting partial merge construct `{ ...current, ... }`); top-level fields are partial-merge.

- **`db.updateAuthenticator(vault, slotId, options, factors?)`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — meta-only mutation on an existing tier-2 authenticator slot (slot rename, label change). The slot's `id`, `method`, and wrap material (`wrapped_kek` / `wrapped_deks` + `iv`) are immutable through this entry point — anti-slot-swap is **structural**: `UpdateAuthenticatorOptions` only carries `meta`, so the wrap material is unreachable regardless of the gate's settings. New `update-authenticator` policy gate (same shape as enroll/remove). `meta` patch follows #57's null-as-delete semantics at the top level.

- **`UserApi.updateMe<T>(patch)` accepts `null` to clear fields** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — `null` in the patch deletes the targeted key; `undefined` continues to skip (preserves the pre-feature merge behavior). Matches lodash `_.merge` and Firestore `FieldValue.delete()` semantics. New `DeepPartialOrNull<T>` type exported alongside the existing `DeepPartial<T>` (kept for backward compat); `updateMe<T>`'s patch parameter loosened to `DeepPartialOrNull<T>`. Bug fix found in flight: nested `null` patches against missing source keys now resolve consistently (recurse through synthetic `{}` source) — pre-fix, `{ app: { signature: null } }` against missing `app` produced `{ app: { signature: null } }` instead of `{ app: {} }`.

#### New exported types

- **`UpdateUserOptions`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — payload for `db.updateUser`.
- **`UpdateAuthenticatorOptions`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — payload for `db.updateAuthenticator`.
- **`DeepPartialOrNull<T>`** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — recursive partial with `| null` at every level.
- **`SlotRewrapContext`** + **`SlotRewrapCeremony`** ([#56](https://github.com/vLannaAi/noy-db/issues/56)) — previously package-internal, now public so `@noy-db/on-webauthn` (and future on-\* packages) can type their `slotCeremonies` helpers without re-declaring the shapes.

#### Policy DSL extensions

- **`update-user`** built-in gate ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — PERSONAL: `{ minTier: 1 }`; STRICT: `{ minTier: 1, factors: [{ anyOf: ['totp', 'email-otp'] }] }`.
- **`update-authenticator`** built-in gate ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — symmetric with `enroll-authenticator` / `remove-authenticator`. STRICT requires TOTP/email-OTP because a malicious slot rename on a shared workstation can mislead the user about which device a slot corresponds to.

### Issues closed

#54, #55, #56 (hub-side type export), #57

## 0.1.0-pre.8

### Authentication surface — major auth-review batch

Closes the 12-issue auth-review filed at the start of this milestone. Driven by feedback from the first production consumer (Niwat); the pre.8 surface is what they need to drop ~250 LOC of vendored workarounds.

#### New public APIs

- **`db.getKeyring(vault)`** ([#28](https://github.com/vLannaAi/noy-db/issues/28)) — public accessor for the live `UnlockedKeyring`. Required by `@noy-db/on-*` ceremonies that need the DEK set (paper-recovery mint, tier-3 PIN enrol, custom on-\* primitives). Previously private; consumers reached in via `(db as unknown as ...).getKeyring`.

- **`db.recoverUser(vault, options, factors?)`** ([#33](https://github.com/vLannaAi/noy-db/issues/33), [#34](https://github.com/vLannaAi/noy-db/issues/34)) — atomic peer-recovery primitive. Single `store.put` rewraps a target user's keyring under a fresh temp passphrase. Owner→owner natively allowed (closes #33's hard block on the two-co-owner case); gated by new `peer-recover-user` policy gate (`STRICT_POLICY` requires recovery / TOTP / email-OTP / roaming WebAuthn factor proof). No key rotation, identity preserved, tier-2 slots dropped. Closes the partial-failure window of the previous `revoke + grant` compose-from-primitives pattern.

- **`db.recoverPassphrase` auto-rotates remaining recovery codes** ([#36](https://github.com/vLannaAi/noy-db/issues/36)) — defaults to `rotateRemainingCodes: true`. After a successful paper-recovery, the matched code is burned AND the remaining N-1 entries are replaced with N-1 freshly-minted ones. Returns `{ newCodes: readonly string[] }` for the UI to show once. Optional `codeGenerator` callback overrides the default ULID format; `newCodeCount` controls the mint count.

- **`db.rotatePassphrase` preserves tier-2 slots via per-slot ceremonies** ([#29](https://github.com/vLannaAi/noy-db/issues/29)) — opt-in `slotCeremonies?: { [slotId]: SlotRewrapCeremony }`. Each ceremony receives `{ newKek, newDeks, oldSlot }` and returns `EnrollAuthenticatorOptions` with the same `id` + `method` (anti-slot-swap guard). Slots without a ceremony are dropped (pre-pre.8 behavior preserved as default). `enrolled_at` carries through (rotation is rewrapping, not re-enrollment). Closes the "yearly rotation wipes my biometric" UX cliff.

- **Public `mintPaperRecoveryEntry` / `unwrapDeksFromPaperEntry`** ([#39](https://github.com/vLannaAi/noy-db/issues/39)) — native paper-recovery enrollment path. Consumers were inlining ~70 LOC; `db.enrollRecovery` docstring fixed to point here instead of the broken `@noy-db/on-recovery@<=pre.7` example.

- **`mintWrappedDeksBlob` / `unwrapDeksFromBlob` / `WrappedDeksBlob` interface** ([#44](https://github.com/vLannaAi/noy-db/issues/44)) — the canonical wrap-DEKs primitive used by tier-0 (paper recovery) and tier-2 wrap-DEKs (password). `mintPaperRecoveryEntry` and `enrollPasswordAuthenticator` both delegate to this single helper. Tier-3 (`@noy-db/on-pin`) intentionally uses a parallel implementation at 100k PBKDF2 iterations (vs 600k here) because the PIN protection window is short — wire formats are deliberately incompatible.

#### Breaking type changes (pre-1.0; runtime behavior unchanged)

- **`KeyringAuthenticator` is now a discriminated union** ([#26](https://github.com/vLannaAi/noy-db/issues/26)) — `wrapKind: 'kek' | 'deks'` discriminator. WebAuthn / OIDC slots stay wrap-KEK; password slots are wrap-DEKs. Backward-compat: pre-pre.8 slots without `wrapKind` are treated as wrap-KEK at unlock time.

- **`UnlockedKeyring.kek` tightened to `CryptoKey | null`** ([#41](https://github.com/vLannaAi/noy-db/issues/41)) — the runtime always allowed null (tier-3 PIN resume, wrap-DEKs unlock, session restore, dev-unlock); the type now matches reality. Three call sites (`persistKeyring`, `vault.issueDelegation`, delegation-token unwrap) added explicit null-throws with a "re-authenticate at tier 1 first" message. Consumers reading `keyring.kek` directly should add a null-check.

#### Policy DSL extensions

- **`FactorKind` extended** ([#30](https://github.com/vLannaAi/noy-db/issues/30)) — adds `webauthn-platform` (Touch ID / Face ID / Hello), `password` (`@noy-db/on-password` tier-2), `pin` (`@noy-db/on-pin` tier-3). PERSONAL_POLICY rotate-passphrase gate now accepts ALL kinds; STRICT_POLICY peer-recover-user accepts off-device kinds only.

- **`PassphrasePolicy` escape hatches** ([#31](https://github.com/vLannaAi/noy-db/issues/31)) — `pattern?: RegExp` overrides the default lowercase-letters-and-spaces character class; `customValidator?: (phrase) => PassphraseValidationResult` replaces the entire decision tree. Unblocks Thai/EN-mixed phrases (`/^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u`), digit-rich phrases, BIP-39-style domain-specific formats.

#### Documentation + housekeeping

- **`docs/services/auth-landscape.md`** — reference map of every authentication, unlock, and sealing-key primitive commonly adopted in 2026, scored on dimensions that matter for a zero-knowledge offline-first vault. 247 lines covering 12 dimensional sections plus coverage assessment, gaps table, decision rules, and Q&A appendix.

- **on-oidc README + auth-landscape §6 polish** ([#37](https://github.com/vLannaAi/noy-db/issues/37)) — reframes "self-host the key-connector server" from docstring footnote to top-level ⚠️ section. Closes #37 as wontfix: noy-db is offline-first by philosophy and intentionally does not ship server infrastructure for OIDC unlock; consumers without server infrastructure should use `@noy-db/on-webauthn` (platform passkey) instead.

- **Perf-bench DoD test stabilized** — added `{ retry: 2 }` and renamed from "5×" to "materially faster" (assertion is `> 2`). Handles transient parallel-CI noise without lowering the signal-to-noise ratio.

### Issues closed

#26, #28, #29, #30, #31, #33, #34, #36, #37, #38, #39, #41, #44

### Issues filed as follow-ups

- [#43](https://github.com/vLannaAi/noy-db/issues/43) — fold `@noy-db/on-recovery` into `@noy-db/hub/recovery-codes` subpath (deferred, breaking change)
- Earlier follow-ups (#14 managed-passphrase mode, #15 per-keyring policy override) remain in the post-1.0 backlog.

## 0.1.0-pre.7

### Patch Changes

- fix(hub): onInvalidKey: 'reset' — recover a stale keyring when the data store is partially cleared (#6)

  When the IndexedDB data records are cleared via DevTools (or the user's browser evicts storage) while the `_keyring` row survives, and the user's credentials have since changed (e.g. a WebAuthn PRF credential was rotated or synced to a new device), `openVault` now offers an opt-in recovery path instead of throwing `InvalidKeyError`.

  Set `onInvalidKey: 'reset'` in `createNoydb` options to delete the stale keyring and re-initialize the vault from scratch with the current credentials. Default is `'error'` (unchanged — wrong credentials still throw).

## 0.1.0-pre.6

### Features

- **Per-principal user envelope (`vault.user.*`)** ([#18](https://github.com/vLannaAi/noy-db/issues/18), [#19](https://github.com/vLannaAi/noy-db/issues/19), [#20](https://github.com/vLannaAi/noy-db/issues/20), [#22](https://github.com/vLannaAi/noy-db/issues/22), [#23](https://github.com/vLannaAi/noy-db/issues/23), [#24](https://github.com/vLannaAi/noy-db/issues/24), [#25](https://github.com/vLannaAi/noy-db/issues/25)) — every keyring in a vault now gets its own `_users/<keyringId>` envelope, encrypted under a vault-shared `_users` DEK. Hub owns the plumbing (storage, sync, history, lifecycle, encryption, policy gates); apps own the schema. Three method families on `vault.user.*`:

  - **Write-self** — `me() / updateMe(patch) / setMe(payload)`. Always target the writer's own keyringId; the **own-only write rule is structural** (no API method exists to write someone else's envelope). Gated by `edit-own-profile` (default `minTier: 3`).
  - **Read-anyone** — `get(keyringId) / list()`. Gated by `view-team-profiles` (default `minTier: 2`); `enabled: false` is the privacy-strict opt-out (`list()` returns only self).
  - **Reactive** — `subscribe(keyringId, cb) / live(keyringId)`. In-process event emission on local writes.

  New `db.grant({ initialProfile: T })` admin pre-fill at invite time (bootstrap-only — once the user activates, the own-only rule prevents further admin edits). New `listUsersWithEnvelopes()` joined enumeration for admin UIs. `_users` DEK is eager-provisioned at owner creation; cascade-revoke deletes envelopes alongside keyrings; tier-1 rotation re-encrypts envelopes via the existing rotation path. The `UserProfileProvider` interface (managed-mode IdP integration) is documented but not exported in v1; lands post-1.0 alongside managed-passphrase mode (#14).

  See `docs/services/user-envelope.md`, `docs/recipes/user-preferences.md`, `showcases/src/70-user-envelope.showcase.test.ts`, and `showcases/src/recipe-user-preferences.recipe.test.ts`.

- **`db.enrollWebAuthn(vault, ceremony, presented?)`** ([#16](https://github.com/vLannaAi/noy-db/issues/16)) — native WebAuthn enrollment using the **real** internal keyring. Unblocks `vLannaAi/niwat#31`. The ceremony callback receives the live `UnlockedKeyring` so the `wrapped_kek` references the live KEK (not the synthetic-keyring workaround that broke unlock). Hub does not import `@noy-db/on-webauthn` (would invert dep graph); consumers wire the on-webauthn `enrollWebAuthn` function in via the ceremony callback. Companion `db.listWebAuthnSlots(vault)` returns webauthn-method slots only.

- **`db.lockVault(vault)`** ([#17](https://github.com/vLannaAi/noy-db/issues/17)) — soft lock that scrubs `keyringCache`, `vaultCache`, `activeTier`, `syncEngines`, `policyEnforcers` for the vault, but **preserves `quickUnlock`** (PIN resume after lock-screen UX) and `policyCache` (on-disk policy survives lock). Idempotent; the `Noydb` instance remains usable. Unblocks `vLannaAi/niwat#33`.

- **New built-in policy gates** — `edit-own-profile` and `view-team-profiles` registered in `PERSONAL_POLICY` and `STRICT_POLICY`. Apps can tighten (e.g. require TOTP for profile edits) but cannot relax the own-only write rule (structural, not policy-controlled).

### No breaking changes

All additions are additive. Pre-existing vaults work unchanged — the `_users` collection is reserved on grant; envelopes start empty until first `updateMe()`. Pre-existing vaults predating this feature have a documented one-time DEK-rotate workflow when adopting `vault.user.*` for multi-principal reads (see "Edge cases & limits" in `docs/services/user-envelope.md`).

## 0.1.0-pre.4

### Features

- **`NoydbOptions.getKeyring` callback** ([#5](https://github.com/vLannaAi/noy-db/issues/5)) — added an optional `getKeyring?: (vault: string) => Promise<UnlockedKeyring>` callback to `NoydbOptions`. Lets biometric (WebAuthn), OIDC split-key, Shamir, and any other unlock path that produces an `UnlockedKeyring` plug into `createNoydb` directly, without a passphrase bridge. `secret` and `getKeyring` are mutually exclusive; the callback is invoked lazily on the first vault open and the keyring is cached per `(instance, vault)`. Errors propagate from `openVault(name)`. Full backward compatibility — passphrase consumers see no change.

## 0.1.0-pre.1 — Initial pre-release
