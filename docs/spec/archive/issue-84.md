# Issue #84 — feat(core): exportStream() bundles dictionary snapshot for self-consistent i18n exports

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-09
- **Milestone:** v0.8.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion vLannaAi/noy-db#78. Part of the v0.8 i18n epic. Depends on `dictKey` (#81) and `exportStream()` (#72, v0.5).

## Problem

An export captured at time T contains records with `dictKey` fields pointing at dictionary state at time T. If the dictionary is later renamed (a label changes), reading the export later **with the current dictionary** produces wrong labels — but the export envelope has no internal way to know that.

The naive fix — "store a pointer to the ledger head and look up the dictionary at that head later" — doesn't work because **v0.4 has no point-in-time read primitive**. There is no way today to say "give me the dictionary as it was at ledger head X."

The right fix is the simpler one: **bundle the dictionary state into the export envelope itself**. The export carries its own dictionary snapshot, the consumer reading the export six months later resolves labels against the snapshot, and renames in the live dictionary do not retroactively corrupt past exports.

## Proposed solution

Extend the `exportStream()` chunk format from #72 to carry per-collection dictionary snapshots alongside the records:

```ts
for await (const chunk of company.exportStream()) {
  // chunk = {
  //   collection: 'invoices',
  //   schema: <StandardSchema>,
  //   refs: { clientId: { targetCollection: 'clients', mode: 'strict' } },
  //   dictionaries: {                      // ← NEW in v0.8
  //     status: {
  //       draft:    { en: 'Draft',    th: 'ฉบับร่าง' },
  //       open:     { en: 'Open',     th: 'เปิด' },
  //       paid:     { en: 'Paid',     th: 'ชำระแล้ว' },
  //     },
  //   },
  //   records: Invoice[],
  // }
}
```

### Behavior

- **Per-collection dictionary surface.** Each chunk includes the dictionaries that the collection's schema declares via `dictKey('name')` references — not every dictionary in the compartment, only the ones this collection actually uses.
- **One snapshot per stream.** Even if the dictionary is mutated mid-export (concurrent writer), the snapshot is captured **once at the start of the stream** for each referenced dictionary. Subsequent chunks within the same stream see the same snapshot. This guarantees internal consistency of the export at the cost of seeing a stale dictionary if it changed during the export.
- **Consumer responsibility for resolution.** The export primitive surfaces the snapshot; format packages (`@noy-db/decrypt-csv`, `@noy-db/decrypt-xml`, etc.) decide whether to resolve labels at write time, embed the dictionary as a sidecar, or include it inline (XML's natural fit — namespaced `<dictionary:status>` element).
- **`exportJSON()` default behavior** — embed the dictionary as a top-level `_dictionaries` key in the output document, alongside the records. Round-trippable: `importJSON()` (a future v0.10+ feature) can re-populate dictionaries from the export.

## Format implications for the `@noy-db/decrypt-*` family

Each format package handles the dictionary snapshot differently. Documenting here so the format-package issues spawned later have a clear contract:

| Format | Default behavior | Override |
|---|---|---|
| `exportJSON()` (core) | Embed under `_dictionaries` key | `{ resolveLabels: 'th' }` resolves at write time, omits the snapshot |
| `@noy-db/decrypt-csv` | Resolve at write time to the configured locale (CSV has no structural way to carry the snapshot) | `{ sidecar: true }` writes a separate `<file>.dict.json` alongside |
| `@noy-db/decrypt-xml` | Inline as `<noydb:dictionary>` namespaced element at the document root | `{ resolveLabels: 'th' }` resolves at write time |
| `@noy-db/decrypt-xlsx` | Separate "Dictionaries" worksheet | `{ resolveLabels: 'th' }` resolves at write time |

The format-package decision matters for export-then-import-elsewhere flows: a CSV that resolves to one locale at write time loses the other languages forever.

## Why this is its own issue and not bundled into #72

#72 ships in v0.5 — before `dictKey` exists. Adding the dictionary surface to `exportStream()` in v0.5 would be defining a contract for a primitive that doesn't yet exist. This issue lands in v0.8 alongside the rest of the i18n epic, **extending** the v0.5 chunk format with the new optional `dictionaries` field. The `dictionaries` field is `undefined` in chunks from collections that don't reference any dictionary, so v0.5 export consumers see no behavior change.

## What this issue does NOT add

- **A point-in-time read primitive** for collections in general — bundled-snapshot avoids needing it for the export case
- **Importer** (`importJSON`) — round-tripping plaintext back into a compartment is a separate v0.10+ feature with its own auth/integrity questions
- **Live export** — the snapshot is captured once at stream start; consumers wanting "live updating exports" should use `.live()` queries instead

## Acceptance

- [ ] `exportStream()` chunks include a `dictionaries` field for collections with `dictKey` references
- [ ] One snapshot per stream, captured at stream start, immutable across chunks within the stream
- [ ] `exportJSON()` embeds the dictionary snapshot under `_dictionaries` by default
- [ ] `exportJSON({ resolveLabels: 'th' })` resolves at write time and omits the snapshot
- [ ] Tests covering: collection without dictKey → no `dictionaries` field; collection with dictKey → snapshot present; concurrent mutation during export → snapshot is stable; round-trip JSON shape preserves the dictionary
- [ ] Updated docstring on `exportStream()` documenting the new optional field
- [ ] Updated `ROADMAP.md` `@noy-db/decrypt-*` table with the per-format dictionary handling defaults
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext — dictionaries are decrypted in core, same path as records
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped
- [x] Zero new external dependencies

v0.8.0 milestone. Depends on #72 (v0.5) and #81 (v0.8 dictKey foundation).
