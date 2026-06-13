# Design docs index (`docs/superpowers/`)

This directory holds the **brainstorm → spec → plan** design docs produced by the superpowers workflow: `specs/` contains the design-of-record for each feature/epic, and `plans/` contains the matching task-by-task implementation plans (all named `YYYY-MM-DD-*.md`). These files are referenced by path in **27 source files** (showcases, tests, `features.yaml`, hub sources), so they are **NOT moved or renamed** — this index is the consolidation that makes them navigable.

The index below groups the 50 specs and 57 plans by **epic / feature area** rather than chronologically. Status is derived from the per-version release-history in the project memory, not from each doc's own (often stale) `Status:` header.

**Status legend:** `shipped vX.Y.Z-pre.N` = landed + released · `design-only` = spec landed, feature deliberately not built · `epic` = umbrella/foundation doc spanning many PRs (per-slice status in its rows) · `unknown` = could not determine.

> Note: `specs/2026-05-01-dimensions/` is a **directory** (the 15-dimension foundation brainstorm + `index.md` + `competitors-feature-mining.md`); it is the single foundational spec entry that every later design graduates from. Its 17 inner files are not enumerated here.

---

## Dimensions foundation

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| 15-dimension brainstorm (foundation for everything below) | [specs/2026-05-01-dimensions/](specs/2026-05-01-dimensions/) ([index](specs/2026-05-01-dimensions/index.md)) | — | epic (foundation) |

## Guards & Derivations (Dim 14 v1)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Derivations v1 (`withDerivation`) | [specs/2026-05-01-dim14-derivation-v1-design.md](specs/2026-05-01-dim14-derivation-v1-design.md) | [plans/2026-05-01-dim14-derivation-v1.md](plans/2026-05-01-dim14-derivation-v1.md), [plans/2026-05-18-derivation.md](plans/2026-05-18-derivation.md) | shipped v0.1.0-pre.11; + declared sibling `sources[]` (#344 / AU+028) v0.2.0-pre.16 |
| Guards (`withGuard` — lock / freeze / amendment) | [specs/2026-05-18-guards-design.md](specs/2026-05-18-guards-design.md) | [plans/2026-05-18-guards.md](plans/2026-05-18-guards.md) | shipped v0.1.0-pre.11 |
| Variable-N derivations (`shape: 'array'`) | [specs/2026-05-23-variable-n-derivations.md](specs/2026-05-23-variable-n-derivations.md) | — | shipped v0.1.0-pre.16 |
| Tier-2 auth showcases (on-webauthn / on-password) | — | [plans/2026-05-18-tier-2-auth-showcases.md](plans/2026-05-18-tier-2-auth-showcases.md) | shipped v0.1.0-pre.11 (showcases 71/72) |

## Materialized Views & Query DSL (Dim 14 v2 / Dim 11)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Materialized views v2 (`withMaterializedView`) | [specs/2026-05-20-dim14-mv-v2-design.md](specs/2026-05-20-dim14-mv-v2-design.md) | — | shipped v0.1.0-pre.14; + overlay field-merge `mergeMode` (#348 / AU+032) v0.2.0-pre.16 |
| Multi-key groupBy + UNION MV (+ GuardStrategyHandle variance) | [specs/2026-05-22-dim14-mv-multikey-and-union-design.md](specs/2026-05-22-dim14-mv-multikey-and-union-design.md) | [plans/2026-05-22-dim14-mv-multikey-and-union.md](plans/2026-05-22-dim14-mv-multikey-and-union.md) | shipped v0.1.0-pre.15; + exact union-MV money `moneyFields` (#350) & arm `join` leg (#347 / AU+031) v0.2.0-pre.16 |
| Cross-join query primitive (Dim 11) | [specs/2026-05-20-dim11-cross-join-v1-design.md](specs/2026-05-20-dim11-cross-join-v1-design.md) | [plans/2026-06-05-dim11-cross-join.md](plans/2026-06-05-dim11-cross-join.md) | shipped v0.2.0-pre.7 |

## Schema dump / introspection

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Schema dump (`noydb describe` + persisted JSON Schema) | [specs/2026-05-22-schema-dump-design.md](specs/2026-05-22-schema-dump-design.md) | — | shipped v0.1.0-pre.16 |
| Runtime schema introspection (`vault.introspect()`, #229) | [specs/2026-06-01-schema-introspection-design.md](specs/2026-06-01-schema-introspection-design.md) | [plans/2026-06-01-229-schema-introspection.md](plans/2026-06-01-229-schema-introspection.md) | shipped v0.2.0-pre.3 |
| Write lifecycle hooks (`onBeforeWrite`/`onAfterWrite`, #230) | [specs/2026-06-01-write-lifecycle-hooks-design.md](specs/2026-06-01-write-lifecycle-hooks-design.md) | [plans/2026-06-01-230-write-lifecycle-hooks.md](plans/2026-06-01-230-write-lifecycle-hooks.md) | shipped v0.2.0-pre.3 |

## Sealing / at-* family / Shamir recovery

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Sealing + at-* dimension foundation (#188–#199) | [specs/2026-05-23-sealing-at-dimension-foundation.md](specs/2026-05-23-sealing-at-dimension-foundation.md) | — | epic (shipped across pre.16 → 0.2.0-pre.1) |
| at-macos-keychain provider (+ envelope alignment) | [specs/2026-05-23-at-macos-keychain.md](specs/2026-05-23-at-macos-keychain.md) | — | shipped v0.1.0-pre.16 |
| Shamir recovery profile dispatch (#196) | [specs/2026-05-23-shamir-recovery-dispatch.md](specs/2026-05-23-shamir-recovery-dispatch.md) | — | shipped v0.1.0-pre.16 |
| Sealed bundle delivery (`autoPassphrases`/`sealedPassphrases`, #197 s1) | [specs/2026-05-23-sealed-bundle-delivery.md](specs/2026-05-23-sealed-bundle-delivery.md) | — | shipped v0.1.0-pre.16 |
| 0.2 umbrella — at-* graduation + bundle auto-unlock | [specs/2026-05-24-0.2-at-family-and-auto-unlock-design.md](specs/2026-05-24-0.2-at-family-and-auto-unlock-design.md) | — | epic → shipped v0.2.0-pre.1 |
| └ Workstream A — Shamir decouple (#211, BREAKING) | (above umbrella) | [plans/2026-05-24-0.2-workstream-A-shamir-decouple.md](plans/2026-05-24-0.2-workstream-A-shamir-decouple.md) | shipped v0.2.0-pre.1 |
| └ Workstream B — cloud-KMS providers (at-aws/gcp/azure) | (above umbrella) | [plans/2026-05-24-0.2-workstream-B-cloud-kms.md](plans/2026-05-24-0.2-workstream-B-cloud-kms.md) | shipped v0.2.0-pre.1 |
| └ Workstream C — generalized bundle auto-unlock (#215) | (above umbrella) | [plans/2026-05-24-0.2-workstream-C-auto-unlock.md](plans/2026-05-24-0.2-workstream-C-auto-unlock.md) | shipped v0.2.0-pre.1 |
| Recipient-target bundle sealing (#197 final slice) | [specs/2026-05-28-recipient-target-bundle-sealing-design.md](specs/2026-05-28-recipient-target-bundle-sealing-design.md) | [plans/2026-05-28-recipient-target-bundle-sealing.md](plans/2026-05-28-recipient-target-bundle-sealing.md) | shipped v0.2.0-pre.2 |

## Transferable partition bundles (milestone 10)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Transferable partition bundles umbrella (#201–#209) | [specs/2026-05-24-transferable-partition-bundles-design.md](specs/2026-05-24-transferable-partition-bundles-design.md) | — | epic → shipped v0.2.0-pre.2 |
| └ `walkClosure` FK walker (#201) | (above umbrella) | [plans/2026-05-24-walk-closure.md](plans/2026-05-24-walk-closure.md) | shipped v0.2.0-pre.2 |
| └ `describeExtraction` dry-run (#202) | (above umbrella) | [plans/2026-05-25-describe-extraction.md](plans/2026-05-25-describe-extraction.md) | shipped v0.2.0-pre.2 |
| └ Extracted-partition wire format (Plan 3a, #203/#206) | (above umbrella) | [plans/2026-05-25-extracted-partition-wire-format.md](plans/2026-05-25-extracted-partition-wire-format.md) | shipped v0.2.0-pre.2 |
| └ `extractPartition` + transfer seal (Plan 3b) | (above umbrella) | [plans/2026-05-25-extract-partition.md](plans/2026-05-25-extract-partition.md) | shipped v0.2.0-pre.2 |
| └ `adoptPartition` (Plan 4, #207) | (above umbrella) | [plans/2026-05-25-adopt-partition.md](plans/2026-05-25-adopt-partition.md) | shipped v0.2.0-pre.2 |
| └ `createOwnerOnAdoptedPartition` + seal cleanup (Plan 5, #208/#209) | (above umbrella) | [plans/2026-05-25-create-owner-on-adopted-partition.md](plans/2026-05-25-create-owner-on-adopted-partition.md) | shipped v0.2.0-pre.2 |
| └ `carrySchemas` opt-in (Plan 6, #204) | (above umbrella) | [plans/2026-05-25-carry-schemas.md](plans/2026-05-25-carry-schemas.md) | shipped v0.2.0-pre.2 |
| └ `carryLedger` opt-in (Plan 7, #205 s1) | (above umbrella) | [plans/2026-05-25-carry-ledger.md](plans/2026-05-25-carry-ledger.md) | shipped v0.2.0-pre.2 |
| └ Source `partition-handed-over` ledger entry (Plan 8, #226) | (above umbrella) | [plans/2026-05-25-partition-handed-over-ledger.md](plans/2026-05-25-partition-handed-over-ledger.md) | shipped v0.2.0-pre.2 |
| └ Destination lifecycle ledger entries (Plan 9, #226) | (above umbrella) | [plans/2026-05-25-destination-lifecycle-ledger.md](plans/2026-05-25-destination-lifecycle-ledger.md) | shipped v0.2.0-pre.2 |
| └ Managed-mode adoption (Plan 10, #208 follow-up) | (above umbrella) | [plans/2026-05-25-managed-mode-adoption.md](plans/2026-05-25-managed-mode-adoption.md) | shipped v0.2.0-pre.2 |

## Document attestation (milestone 11)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Document attestation umbrella (① – ⑤) | [specs/2026-05-29-document-attestation-umbrella-design.md](specs/2026-05-29-document-attestation-umbrella-design.md) | — | epic → shipped v0.2.0-pre.2 |
| ① Core + issue side (`@noy-db/attestation` + hub/attestation) | [specs/2026-05-29-attestation-core-and-issue-design.md](specs/2026-05-29-attestation-core-and-issue-design.md) | [plans/2026-05-29-attestation-core-package.md](plans/2026-05-29-attestation-core-package.md), [plans/2026-05-29-attestation-hub-issue-side.md](plans/2026-05-29-attestation-hub-issue-side.md) | shipped v0.2.0-pre.2 |
| ④ Offline verifier recipe | [specs/2026-05-29-attestation-verifier-design.md](specs/2026-05-29-attestation-verifier-design.md) | [plans/2026-05-29-attestation-verifier.md](plans/2026-05-29-attestation-verifier.md) | shipped v0.2.0-pre.2 |
| ③ AWS-KMS PDF render recipe | [specs/2026-05-30-attestation-kms-pdf-recipe-design.md](specs/2026-05-30-attestation-kms-pdf-recipe-design.md) | [plans/2026-05-30-attestation-kms-pdf-recipe.md](plans/2026-05-30-attestation-kms-pdf-recipe.md) | shipped v0.2.0-pre.2 |
| ⑤ Revocation publishing | [specs/2026-05-30-attestation-revocation-publishing-design.md](specs/2026-05-30-attestation-revocation-publishing-design.md) | [plans/2026-05-30-attestation-revocation-publishing.md](plans/2026-05-30-attestation-revocation-publishing.md) | shipped v0.2.0-pre.2 |
| ③ Magic-link share capability (hardening) | [specs/2026-05-31-attestation-share-link-design.md](specs/2026-05-31-attestation-share-link-design.md) | [plans/2026-05-31-attestation-share-link.md](plans/2026-05-31-attestation-share-link.md) | shipped v0.2.0-pre.2 (post-epic hardening) |

## Schema migration (M12, milestone 12)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| M12 schema migration & coordinated cutover (epic) | [specs/2026-05-31-m12-schema-migration-epic-design.md](specs/2026-05-31-m12-schema-migration-epic-design.md) | — | epic → shipped v0.2.0-pre.3 |
| └ Slice 1 — observable write-queue / flush | (above epic) | [plans/2026-05-31-m12-slice1-observable-write-queue.md](plans/2026-05-31-m12-slice1-observable-write-queue.md) | shipped v0.2.0-pre.3 |
| └ #245 schema-update strategy framework | (above epic) | [plans/2026-05-31-m12-245-schema-update-framework.md](plans/2026-05-31-m12-245-schema-update-framework.md) | shipped v0.2.0-pre.3 |
| └ #232 sub-slice 3a — coordinated cutover (single-client) | (above epic) | [plans/2026-05-31-m12-232a-coordinated-cutover-single-client.md](plans/2026-05-31-m12-232a-coordinated-cutover-single-client.md) | shipped v0.2.0-pre.3 |
| └ #232 sub-slice 3b — coordinated cutover (multi-client) | (above epic) | [plans/2026-06-01-m12-232b-coordinated-cutover-multiclient.md](plans/2026-06-01-m12-232b-coordinated-cutover-multiclient.md) | shipped v0.2.0-pre.3 |
| └ #233 Slice 4 — `useMigrationState` (Vue) | (above epic) | [plans/2026-06-01-m12-233-vue-migration-state.md](plans/2026-06-01-m12-233-vue-migration-state.md) | shipped v0.2.0-pre.3 |

## Hub coordination / tab sync (#228 + #231)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Hub coordination epic (#228 + #231) | [specs/2026-06-01-hub-coordination-epic-design.md](specs/2026-06-01-hub-coordination-epic-design.md) | — | epic → shipped v0.2.0-pre.3 |
| Dry-run transactions (#231) | (above epic) | [plans/2026-06-01-231-dry-run-transactions.md](plans/2026-06-01-231-dry-run-transactions.md) | shipped v0.2.0-pre.3 |
| Commit-time tx changeset invariants (`withTransactions({ invariants })`, #342 / AU+026) | [specs/2026-06-13-tx-commit-invariants-design.md](specs/2026-06-13-tx-commit-invariants-design.md) | — | shipped v0.2.0-pre.16 |
| Multi-tab coordination — decomposition + (a) presence/roles | [specs/2026-06-01-228-tab-coordination-design.md](specs/2026-06-01-228-tab-coordination-design.md) | [plans/2026-06-01-228a-tab-presence-roles.md](plans/2026-06-01-228a-tab-presence-roles.md) | shipped v0.2.0-pre.3 |
| (b) Cross-tab write propagation | [specs/2026-06-01-228b-cross-tab-write-propagation-design.md](specs/2026-06-01-228b-cross-tab-write-propagation-design.md) | [plans/2026-06-01-228b-cross-tab-write-propagation.md](plans/2026-06-01-228b-cross-tab-write-propagation.md) | shipped v0.2.0-pre.3 |
| (c) Cross-tab conflict detection | [specs/2026-06-01-228c-conflict-detection-design.md](specs/2026-06-01-228c-conflict-detection-design.md) | [plans/2026-06-01-228c-conflict-detection.md](plans/2026-06-01-228c-conflict-detection.md) | shipped v0.2.0-pre.3 (flake fixed pre.7) |

## Track A — kernel shrink (SubsystemBus)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| Kernel-shrink + devtools proposal | [specs/2026-06-01-kernel-shrink-and-devtools-proposal.md](specs/2026-06-01-kernel-shrink-and-devtools-proposal.md) | — | epic (Track A → pre.5, Track B → pre.6) |
| └ Slice 1 — subsystem observe bus | (above proposal) | [plans/2026-06-01-track-a-subsystem-bus-slice-1.md](plans/2026-06-01-track-a-subsystem-bus-slice-1.md) | shipped v0.2.0-pre.5 |
| └ Slice 2 — subsystem gate bus | (above proposal) | [plans/2026-06-01-track-a-gate-bus-slice-2.md](plans/2026-06-01-track-a-gate-bus-slice-2.md) | shipped v0.2.0-pre.5 |
| └ Slice 3a — migrate periods onto gate bus | (above proposal) | [plans/2026-06-01-track-a-migrate-periods-slice-3a.md](plans/2026-06-01-track-a-migrate-periods-slice-3a.md) | shipped v0.2.0-pre.5 |
| └ Slice 3b — migrate guards onto gate bus | (above proposal) | [plans/2026-06-01-track-a-migrate-guards-slice-3b.md](plans/2026-06-01-track-a-migrate-guards-slice-3b.md) | shipped v0.2.0-pre.5 |

> Track A shipped as the single squashed PR #262 (the 6-PR stack #256/#257/#259/#260/#261 was collapsed into it — those PRs were closed as superseded, NOT abandoned). Reduced scope: the two subsystem splits + prior-read opt deferred to #267.

## DevTools (Track B, milestone 15)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| B1 — inspector core (`@noy-db/in-devtools`) | [specs/2026-06-02-devtools-inspector-b1-design.md](specs/2026-06-02-devtools-inspector-b1-design.md) | [plans/2026-06-02-devtools-inspector-b1.md](plans/2026-06-02-devtools-inspector-b1.md) | shipped v0.2.0-pre.6 |
| B2 — TUI (overview + B2.1 shell/structure) | [specs/2026-06-02-devtools-inspector-b2-tui-design.md](specs/2026-06-02-devtools-inspector-b2-tui-design.md) | [plans/2026-06-02-devtools-tui-b2.1.md](plans/2026-06-02-devtools-tui-b2.1.md) | shipped v0.2.0-pre.6 |
| B2.2 records + B2.3 write monitor | [specs/2026-06-02-devtools-tui-b2.2-b2.3-design.md](specs/2026-06-02-devtools-tui-b2.2-b2.3-design.md) | [plans/2026-06-02-devtools-tui-b2.2-b2.3.md](plans/2026-06-02-devtools-tui-b2.2-b2.3.md) | shipped v0.2.0-pre.6 |
| B3 — Nuxt DevTools tab (`@noy-db/in-nuxt`) | [specs/2026-06-03-devtools-nuxt-b3-design.md](specs/2026-06-03-devtools-nuxt-b3-design.md) | [plans/2026-06-03-devtools-nuxt-b3.md](plans/2026-06-03-devtools-nuxt-b3.md) | shipped v0.2.0-pre.6 |

## i18n hardening (milestone 17)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| i18n multilingual-field hardening (hub core) | [specs/2026-06-05-i18n-multilingual-field-hardening-design.md](specs/2026-06-05-i18n-multilingual-field-hardening-design.md) | [plans/2026-06-06-i18n-multilingual-field-hardening.md](plans/2026-06-06-i18n-multilingual-field-hardening.md) | shipped v0.2.0-pre.8 |
| in-pinia reactive i18n binding | [specs/2026-06-06-in-pinia-reactive-i18n-design.md](specs/2026-06-06-in-pinia-reactive-i18n-design.md) | [plans/2026-06-06-in-pinia-reactive-i18n.md](plans/2026-06-06-in-pinia-reactive-i18n.md) | shipped v0.2.0-pre.8 |
| i18n static / code-provided dictionary (`staticDict`, #291) | [specs/2026-06-07-i18n-static-dictionary-design.md](specs/2026-06-07-i18n-static-dictionary-design.md) | — | design-only (issue #291 OPEN — pending, not yet built) |

## Snapshots

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| `withSnapshots()` snapshot-lifecycle subsystem (#279) | — | [plans/2026-06-05-with-snapshots.md](plans/2026-06-05-with-snapshots.md) | shipped v0.2.0-pre.7 |
| Snapshots auto-cadence (`snapshotPolicy`) + S3 bundle adapter | [specs/2026-06-07-snapshots-auto-cadence-and-s3-bundle-design.md](specs/2026-06-07-snapshots-auto-cadence-and-s3-bundle-design.md) | [plans/2026-06-07-snapshots-auto-cadence-s3-bundle.md](plans/2026-06-07-snapshots-auto-cadence-s3-bundle.md) | shipped v0.2.0-pre.9 |

## Multi-vault federation (milestone 16, epic #271)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| VaultGroup routing MVP (`withVaultTemplate`/`openVaultGroup`) | [specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md](specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md) | [plans/2026-06-07-mvf-vaultgroup-routing.md](plans/2026-06-07-mvf-vaultgroup-routing.md) | shipped v0.2.0-pre.12 |
| Cross-vault live + distributed aggregate (Phase 3, +#312 A/B/E) | [specs/2026-06-07-cross-vault-live-and-aggregate-design.md](specs/2026-06-07-cross-vault-live-and-aggregate-design.md) | [plans/2026-06-08-cross-vault-live-aggregate-and-312.md](plans/2026-06-08-cross-vault-live-aggregate-and-312.md) | shipped v0.2.0-pre.12 |
| StateManagement Vault (Layer 3) | [specs/2026-06-08-statemanagement-vault-design.md](specs/2026-06-08-statemanagement-vault-design.md) | [plans/2026-06-08-statemanagement-vault.md](plans/2026-06-08-statemanagement-vault.md) | shipped v0.2.0-pre.13 |
| `crossShardJoin` + `broadcastJoin` | [specs/2026-06-09-cross-shard-join-design.md](specs/2026-06-09-cross-shard-join-design.md) | [plans/2026-06-09-cross-shard-join.md](plans/2026-06-09-cross-shard-join.md) | shipped v0.2.0-pre.14 |

> Epic #271 remains OPEN: Insight Vault (`withCrossVaultDerivation`, blocked on cross-vault DEK-grant design) and the fleet schema-migration runner are not yet built.

## Fiscal primitives (milestone 17 / Pilot-3, m17)

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| `money()` currency-safe decimal field (#300) | [specs/2026-06-08-money-decimal-field-design.md](specs/2026-06-08-money-decimal-field-design.md) | [plans/2026-06-08-money-decimal-field.md](plans/2026-06-08-money-decimal-field.md) | shipped v0.2.0-pre.12 |
| Computed scalar fields (#302) | [specs/2026-06-08-computed-scalar-fields-design.md](specs/2026-06-08-computed-scalar-fields-design.md) | — | shipped v0.2.0-pre.12 |
| `immutableGuard` WORM (#301) | [specs/2026-06-08-immutable-guard-design.md](specs/2026-06-08-immutable-guard-design.md) | — | shipped v0.2.0-pre.12; + `amendmentInvariant` knob (#349 / AU+033) v0.2.0-pre.16 |
| Retention + legal-hold (blobs #311 / record archival #307) | [specs/2026-06-08-retention-archival-design.md](specs/2026-06-08-retention-archival-design.md) | — | shipped v0.2.0-pre.12 |
| Deferred deterministic numbering + store clock (#325) | [specs/2026-06-08-sealed-numbering-and-store-clock-design.md](specs/2026-06-08-sealed-numbering-and-store-clock-design.md) | [plans/2026-06-08-deferred-numbering.md](plans/2026-06-08-deferred-numbering.md) | shipped v0.2.0-pre.13 |
| `withForgetCascade` — DEK crypto-shred (#304) | [specs/2026-06-08-forget-cascade-design.md](specs/2026-06-08-forget-cascade-design.md) | — | design-only (#304 open, not built) |

## openVault security

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| `openVault` no-self-provision (#313) | [specs/2026-06-08-openvault-no-self-provision-design.md](specs/2026-06-08-openvault-no-self-provision-design.md) | [plans/2026-06-08-openvault-no-self-provision-313.md](plans/2026-06-08-openvault-no-self-provision-313.md) | shipped v0.2.0-pre.11 |

## User envelope

| Topic | Spec | Plan(s) | Status |
|---|---|---|---|
| User envelope (`_meta/user/<keyringId>`) | [specs/2026-05-05-user-envelope-design.md](specs/2026-05-05-user-envelope-design.md) | — | shipped v0.1.0-pre.6 (envelope never published; surface stable on later lines) |
