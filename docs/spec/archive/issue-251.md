# Issue #251 — feat(as-ndjson): @noy-db/as-ndjson — newline-delimited JSON for streaming large vaults

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, area: core

---

## `@noy-db/as-ndjson` — newline-delimited JSON export

Streaming-friendly sibling to `@noy-db/as-json` (#250). Each line is one JSON record; the stream can be piped into `jq`, `fx`, log pipelines, or a downstream reducer without ever loading the whole vault into memory.

**Why NDJSON?**

Large-vault exports (50K records) produce ~100 MB of JSON — loading the whole array into memory on the client is clumsy. NDJSON is line-delimited:

```
{"_schema":"invoices","id":"01H...","amount":1500,"status":"paid"}
{"_schema":"invoices","id":"01H...","amount":2400,"status":"draft"}
{"_schema":"payments","id":"01H...","invoiceId":"01H...","amount":1500}
```

A one-pass reader processes each line independently — ideal for ingesting the export into a data warehouse, a reporting tool, or a migration script.

## API sketch

```ts
import { asNDJSON } from '@noy-db/as-ndjson'

// Browser download (streamed via TransformStream)
await asNDJSON.download(vault, { filename: 'export.ndjson' })

// Node write stream
import { createWriteStream } from 'node:fs'
await asNDJSON.pipe(vault, createWriteStream('/tmp/export.ndjson'), { acknowledgeRisks: true })

// Async iterator
for await (const line of asNDJSON.stream(vault)) {
  process.stdout.write(line + '\n')
}
```

Each line carries a `_schema` field naming the source collection so the consumer can route records without a separate header pass.

## Authorization + audit

Same gate as every `as-*` package: owner-granted `canExportPlaintext` (#249), optional JIT re-auth, one audit-ledger entry per export (not per line).

## Acceptance

- [ ] Package skeleton under `packages/as-ndjson/`
- [ ] Streaming write (no full-vault in memory)
- [ ] Honours `canExportPlaintext` capability (blocked by #249)
- [ ] Single audit-ledger entry per export invocation (not per line) with total `recordCount`
- [ ] Showcase with a 10K-record vault demonstrating constant memory
- [ ] README with plaintext-on-disk warning

Blocked by #249.
