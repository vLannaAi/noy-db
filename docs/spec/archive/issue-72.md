# Issue #72 — feat(core): exportStream() + exportJSON() — authorization-aware export primitive

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.5.0
- **Labels:** type: feature, area: core, release: v0.5

---

## Target package

`@noy-db/core`

## Spawned from

Discussion vLannaAi/noy-db#70 — see [the maintainer position comment](https://github.com/vLannaAi/noy-db/discussions/70#discussioncomment-16476698) for the scope rationale, and [the package-family policy comment](https://github.com/vLannaAi/noy-db/discussions/70#discussioncomment-16476703) for why every other format lives in its own `@noy-db/decrypt-*` package and not in core.

## Problem

`company.dump()` produces an **encrypted, tamper-evident envelope** — it is the right answer for backup and transport, the wrong answer for interoperability with downstream tooling that expects plaintext records. Today the only way to get plaintext out of a compartment is to call `.toArray()` on every collection by hand, fold the schema/refs metadata in by hand, and reimplement the authorization-aware iteration that the library already does internally.

That iteration is the part **only the library can implement correctly** — it has to honor the per-collection ACL, respect the declared Standard Schema, surface the v0.4 `ref()` graph, stream over large collections without OOM, and attribute reads through the normal `Noydb` authorization path. Without a library-owned primitive, every export-format package would have to re-solve those problems independently and would get them subtly wrong in different ways.

## Proposed solution

Two new APIs on `Compartment`:

### 1. `exportStream()` — the primitive

```ts
for await (const chunk of company.exportStream()) {
  // chunk = {
  //   collection: 'invoices',
  //   schema: <StandardSchema | null>,
  //   refs: { clientId: { targetCollection: 'clients', mode: 'strict' }, ... },
  //   records: Invoice[],          // plaintext, ACL-scoped
  //   ledgerHead?: { hash, length, ... },   // optional, opt-in via { withLedgerHead: true }
  // }
}
```

- **Per-chunk default** (one chunk per collection) — matches how consumers think about exports
- **Per-record opt-in** via `company.exportStream({ granularity: 'record' })` — yields one record at a time, never materializes the full collection
- **ACL-scoped** — collections the caller cannot read are silently skipped (same behavior as `.list()` today). A caller with operator permissions on a 5-collection compartment exports only the collections they're allowed to read.
- **Schema + refs surfaced as metadata** so downstream serializers can produce schema-aware output (XSD generation, typed CSV headers, etc.) without poking at internals
- **Streaming I/O** — async generator. The full compartment is never materialized.
- **No new crypto, no new dependencies** — pure orchestration over existing decrypt + ACL primitives.

### 2. `exportJSON(target)` — the universal default helper

```ts
await company.exportJSON('./backup.json')
// → writes a single JSON document containing every collection the caller can read,
//   with schema + refs metadata, in a stable on-disk shape
```

Five-line wrapper on top of `exportStream()`. Zero dependencies. Lives in core because:

1. JSON has zero external deps (preserves the core invariant)
2. JSON is the lowest-common-denominator output every consumer wants
3. The plaintext-on-disk warning (see below) belongs on the JSON helper too — it's the same risk as every `@noy-db/decrypt-*` package, just shipped in core because the format itself doesn't justify a separate package

## Plaintext-on-disk warning

The `exportJSON()` JSDoc, the `Noydb` README, and the published function description all carry the same explicit block:

> **⚠ `exportJSON()` decrypts your records and writes plaintext to disk.**
>
> noy-db's threat model assumes that records on disk are encrypted. This function deliberately violates that assumption: it produces a JSON file in plaintext, which the consumer is then responsible for protecting (filesystem permissions, full-disk encryption, secure transfer, secure deletion).
>
> Use this function only when:
> - You are the authorized owner of the data, **and**
> - You have a legitimate downstream tool that requires plaintext JSON, **and**
> - You have a documented plan for how the resulting file will be protected and eventually destroyed.
>
> If your goal is encrypted backup or transport between noy-db instances, use **`company.dump()`** instead — it produces a tamper-evident encrypted envelope, never plaintext.

The `exportStream()` primitive carries a shorter version of the same warning since it is the underlying decrypt path that every `@noy-db/decrypt-*` format package will build on.

## Composes with cross-compartment queries (#63)

Once `exportStream()` exists per-compartment, fanning it out across every compartment the caller can unlock is just `queryAcross(ids, c => c.exportStream())`. The cross-compartment export story falls out without any new primitives. This is one of the load-bearing reasons `exportStream()` belongs in core.

## What's NOT in this issue

- **CSV / XML / xlsx serializers** — separate `@noy-db/decrypt-csv`, `@noy-db/decrypt-xml`, `@noy-db/decrypt-xlsx` packages, milestoned for v0.6.0+. See vLannaAi/noy-db#70 (second maintainer comment) for the package-family policy and naming rationale.
- **MySQL / DDL emitters** — explicitly out of scope. Userland ETL tools cover the JSON-or-CSV → MySQL path. A short paragraph in `ROADMAP.md` will document the position so it stops being a recurring question.
- **Redaction hooks** — consumer concern. The primitive stays neutral.
- **Importer** — round-tripping plaintext back into a compartment is a separate v0.6+ feature with its own auth + integrity questions.

## Tests

- `exportStream()` over an empty compartment → empty async iteration
- `exportStream()` over a multi-collection compartment as owner → every collection appears, in deterministic order
- `exportStream()` as operator with partial grants → only granted collections appear, no error on the others
- `exportStream()` with `granularity: 'record'` → per-record yield, no collection-level materialization
- `exportStream({ withLedgerHead: true })` → chunk metadata includes the current ledger head
- `exportJSON()` round-trip: write to a temp path, read back, assert shape matches `Compartment.toArray()` per collection
- `exportJSON()` warns / refuses on a path that already exists (behavior to be decided in PR — refuse by default, opt-in `{ overwrite: true }`)
- All existing 376 core tests still pass

## Invariant compliance

- [x] Adapters never see plaintext — `exportStream()` runs in core, after decryption, never touches the adapter layer with anything but the existing read calls
- [x] No new runtime crypto dependencies — pure orchestration
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped — the existing per-collection decrypt path is reused as-is
- [x] Zero new external dependencies in `@noy-db/core`

## Acceptance

- [ ] `Compartment.exportStream()` async generator with the documented chunk shape
- [ ] `Compartment.exportJSON(target, options?)` helper writing to a file path
- [ ] JSDoc warning block on both APIs
- [ ] README section under "Backup and export" explaining when to use `dump()` (encrypted) vs `exportJSON()` (plaintext)
- [ ] `ROADMAP.md` paragraph stating the no-MySQL-DDL position
- [ ] Tests covering ACL-scoped iteration, per-record granularity, ledger head metadata, and round-trip JSON shape
- [ ] Full turbo pipeline green
- [ ] Privacy guard clean
- [ ] Changeset (`@noy-db/core: minor`)

Closes part of v0.5.0 export-primitive work. Format-package follow-ups tracked separately.
