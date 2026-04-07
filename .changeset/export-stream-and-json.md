---
"@noy-db/core": minor
---

Add `Compartment.exportStream()` and `Compartment.exportJSON()` — authorization-aware plaintext export (closes #72).

The v0.4 owner-only `Compartment.export()` method has been **removed** and replaced with two new APIs that solve the problems consumers actually have: ACL-scoped iteration, schema/refs metadata for downstream serializers, and streaming so arbitrarily large compartments don't have to be materialized as a single value.

### `exportStream()` — the primitive

```ts
for await (const chunk of company.exportStream()) {
  // chunk.collection: 'invoices'
  // chunk.schema: StandardSchemaV1<unknown, T> | null
  // chunk.refs: { clientId: { target: 'clients', mode: 'strict' } }
  // chunk.records: Invoice[]   // decrypted, ACL-scoped
}
```

- **ACL-scoped.** Collections the calling principal cannot read are silently skipped (same rule as `Collection.list()`). An operator with `{ invoices: 'rw' }` permissions on a five-collection compartment exports only `invoices`, with no error on the others.
- **Streaming output.** Returns an `AsyncIterableIterator<ExportChunk>` so consumers can process chunks as they arrive.
- **Schema + refs surfaced** as metadata on every chunk so downstream serializers (the upcoming `@noy-db/decrypt-*` packages, custom exporters) can produce schema-aware output without poking at collection internals.
- **`granularity: 'record'`** opt-in yields one chunk per record with a length-1 `records` array — useful for arbitrarily large collections that should never be held as a single array.
- **`withLedgerHead: true`** opt-in attaches the current compartment ledger head to every chunk. The value is identical across chunks today (one ledger per compartment) but the per-chunk slot is forward-compatible with future per-partition ledgers.

### `exportJSON()` — the universal default helper

```ts
const json = await company.exportJSON()
await fs.writeFile('./backup.json', json)
```

Five-line wrapper that consumes `exportStream()` and serializes to a single JSON string with a stable on-disk shape (`_noydb_export`, `_compartment`, `_exported_at`, `_exported_by`, `collections`, optional `ledgerHead`).

Returns `Promise<string>` rather than accepting a file path because **core has zero `node:` imports** and runs unchanged in browsers, Node, Bun, Deno, and edge runtimes. The consumer chooses any sink (`fs.writeFile`, `Blob` download, `fetch` upload, IndexedDB) and the destination decision stays explicit at the call site — which is also better for the security warning, since there's no library function quietly writing plaintext somewhere.

### Plaintext-on-disk warning

Both APIs carry an explicit warning block in JSDoc and the new "Backup and export" section of the README:

> **⚠ This method decrypts your records and produces plaintext.** noy-db's threat model assumes that records on disk are encrypted; this function deliberately violates that assumption. Use only when you are the authorized owner, you have a legitimate downstream tool that requires plaintext, and you have a documented plan for how the resulting plaintext will be protected and eventually destroyed. If your goal is encrypted backup or transport between noy-db instances, use **`dump()`** instead.

### Breaking changes

- **`Compartment.export()` is removed.** It was owner-only, eager, returned a JSON string with no metadata, and threw `PermissionDeniedError` for non-owners. The new `exportJSON()` is strictly more capable: any caller who can read collections can now export them (scoped to what they can read), and the on-disk shape carries the metadata that downstream tooling actually needs. Migration is one line:
  ```ts
  // before
  const json = await comp.export()
  // after
  const json = await comp.exportJSON()
  ```
- The old method's owner-only error path is gone. Non-owners no longer throw; they get an export of just the collections they can read. The `access-control.test.ts` "operator cannot export" test has been updated to assert the new ACL-scoped behavior instead.

### New types in the public API

- `ExportStreamOptions` — `{ granularity?: 'collection' | 'record'; withLedgerHead?: boolean }`
- `ExportChunk<T>` — `{ collection, schema, refs, records, ledgerHead? }`

### New on `Collection`

- `Collection.getSchema()` — public getter that returns the attached `StandardSchemaV1` validator (or `undefined`). Added so `Compartment.exportStream()` can surface schemas without reaching into private fields. Read-only by contract.

### Composition with cross-compartment queries (#63)

Once `queryAcross()` lands (the next #63 issue in v0.5.0), fanning the export across every compartment the caller can unlock is `queryAcross(ids, c => c.exportStream())` — no new primitive needed. That's part of why this method belongs in core: it's the single decrypt+ACL+metadata path that every export-format package will build on.

### Tests

16 new tests in `packages/core/__tests__/export-stream.test.ts` covering empty compartments, owner/operator/viewer/client ACL scoping, collection vs record granularity, schema/refs metadata, opt-in ledger head, and the `exportJSON()` round-trip shape. Two existing tests in `access-control.test.ts` updated to reflect the ACL-scoped behavior. Full core suite: 392 tests passing.

Part of v0.5.0.
