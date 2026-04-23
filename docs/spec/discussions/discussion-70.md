# Discussion #70 — Plaintext exports (JSON / CSV / xlsx / MySQL?) — scope boundary and core primitive

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **State:** closed
- **Comments:** 4
- **URL:** https://github.com/vLannaAi/noy-db/discussions/70

---

noy-db already has `company.dump()`, but its purpose is **encrypted, tamper-evident transport** — an archival/backup format, not an interoperability format. What this discussion is about is the opposite: **plaintext exports in formats other tools can read** (JSON, CSV, Excel, and the deliberately-provocative "why not MySQL SQL dumps?" question).

This is a scope-boundary discussion, not a feature request. I think the answer is "yes to some of it, no to others, and the split matters a lot." I'd like maintainer alignment before anyone writes code or opens issues.

## Framing

Export-to-plaintext is **not** a zero-knowledge violation. The owner already holds the keys; letting them write their own plaintext out is what "you own your data" means. The philosophical tension is not about encryption — it's about **scope bloat** against the library's defining "zero runtime dependencies" invariant. Every format added either pulls in a dep (xlsx is ~1 MB and has a CVE history) or becomes a hand-rolled project (MySQL DDL generation).

That constraint is what forces the split below.

## The split I'd argue for

### Core owns a single primitive: `exportStream()`

```ts
for await (const chunk of company.exportStream()) {
  // chunk = {
  //   collection: 'invoices',
  //   schema: <StandardSchema>,
  //   refs: { clientId: { targetCollection: 'clients', mode: 'strict' } },
  //   records: [...],   // plaintext, ACL-scoped, ref metadata attached
  // }
}
```

This is the part **only noy-db can implement correctly**: it has to honor the ACL, respect the declared schema, surface the v0.4 ref graph, stream over large collections without OOM, and attribute reads through the normal authorization path. It's ~100 lines, has zero external dependencies, and composes cleanly with the cross-compartment `queryAcross` proposal in #63 (once you can stream one compartment, you can fan out over N).

Without this primitive, every format serializer has to independently re-solve the hard parts: authorized iteration, schema/ref resolution, pagination, streaming. **That** is the duplication worth preventing. Once it exists, the format serializers are boring.

### Core also ships JSON

Trivial helper on top of `exportStream()`. 5 lines of code, zero deps, obvious default, every consumer wants it.

```ts
await company.exportJSON('./backup.json')          // ACL-scoped plaintext JSON
```

### Optional peer-dep packages for the rest

Following the same pattern as adapters (`@noy-db/file`, `@noy-db/dynamo`, etc.), each format lives in its own package, each declares its format library as a **peer dep**, and core stays zero-dep:

- **`@noy-db/export-csv`** — zero-dep (CSV is ~50 lines of correct code, not worth a peer dep). Worth owning because people get escaping wrong and shipping a tested version prevents the same bug being re-invented in every consumer.
- **`@noy-db/export-xlsx`** — `xlsx` or `exceljs` as a peer dep. The format library is too heavy and too CVE-prone to pull into core. But the demand is real — every business consumer wants it — and peer-dep isolation is the right compromise.

### Explicitly out of scope: MySQL (and any other DBMS DDL dump)

Generating `CREATE TABLE` DDL from a Standard Schema means type mapping, identifier quoting, charset/collation, `AUTO_INCREMENT`, enum handling, date/datetime precision, reserved-word escaping, and a long tail of vendor-specific edge cases. It's a project, not a feature.

More importantly, **it confuses what noy-db is**. A zero-knowledge encrypted document store that also ships a relational DDL generator is two libraries. The right userland answer is: "export to JSON or CSV, then `mysqlimport` or a generic ETL tool handles the load into whatever relational database you want." Every generic ETL tool in existence already does the JSON-or-CSV → MySQL step.

The outcome I'd like on MySQL: a short section in `ROADMAP.md` or the architecture docs stating the position and pointing consumers at the userland path. Same treatment as the SQL-frontend discussion in #66.

## Format-by-format summary

| Format | Scope | Reason |
|---|---|---|
| `exportStream()` primitive | **Core** | Only the library can implement ACL/schema/ref correctness. |
| JSON | **Core** helper | 5 lines, zero deps, universal default. |
| CSV | **`@noy-db/export-csv`** (zero-dep) | Correct escaping is worth sharing; not worth a peer dep. |
| Excel (.xlsx) | **`@noy-db/export-xlsx`** (peer dep) | Real demand, but format lib is too heavy / CVE-prone for core. |
| MySQL SQL dump | **Out of scope** | Project-sized, philosophically confused, userland ETL already handles it. |

## Open questions for the discussion

1. **Is `exportStream()` in core the right shape**, or is it better placed in a new `@noy-db/export-core` package that the format packages depend on? I lean toward core because it's the authorization-aware part, but I can see the argument for keeping core strictly about records-and-crypto.
2. **Does `exportStream()` stream per-record or per-chunk?** Per-chunk (collection at a time) is simpler and matches how consumers think about exports; per-record is more memory-friendly on huge collections. Maybe both: per-chunk by default, opt-in per-record iterator.
3. **Does the stream surface the ledger head alongside the data?** For a consumer producing a plaintext audit trail, pairing the export with the ledger head that was current at export time is useful ("this export is consistent with ledger state `a1b2c3...`"). Optional metadata.
4. **How do attachments (see the blob-store discussion #67) participate?** If blobs land, does `exportStream()` emit them inline, emit them as references to a sidecar directory, or skip them unless opted in? Probably the sidecar-directory answer, but worth naming now so the blob discussion and this discussion don't contradict each other later.
5. **Is there a principled way to ship xlsx without `xlsx`?** Writing the OOXML zip by hand is maybe 300 lines for a read-only-by-Excel subset. Probably not worth it vs. peer-dep, but worth considering if `xlsx` can't pass the security review.
6. **Redaction hooks.** Should `exportStream()` support a per-field redactor callback, so a consumer can ship a "public" export with sensitive fields masked? Or is that a consumer concern? I lean consumer concern — keep the primitive neutral.

## What I'd like out of this discussion

An **explicit maintainer position** on:

- Whether `exportStream()` belongs in core or in its own package.
- Whether the peer-dep-per-format split is the right pattern.
- A documented "no" on MySQL DDL generation, so consumers stop asking.

Once that's settled, the actual feature work splits into small issues cleanly (one for the core primitive, one for JSON helper, one per optional package). Until it's settled, any of those issues would land in a vacuum on the scope question.


> _Comments are not archived here — see the URL for the full thread._
