# Dimension 12 — Stream data shape

## Purpose

Promote *append-only event sequences* from a derived pattern (which `withHistory`'s ledger and `withPeriods` time-partitioning each implement partially) to a **first-class data shape** alongside records and blobs. Streams have a fundamentally different cost model, query model, and consistency model from records — and pretending they're "records with a timestamp field" leaks abstraction badly at scale.

## Why streams are a distinct shape

| Axis | Record | Blob | **Stream** |
|---|---|---|---|
| Addressing | by id | by id | by **offset / time / sequence** |
| Mutation | `put`/`delete` | `put`/`delete` | **`append` only** |
| Read pattern | random / query | get-whole / range | **cursor / live-tail** |
| Bounded? | yes (50K ceiling) | yes (per-blob) | **no — retention bounds it** |
| Backend fit | KV, doc, RDBMS | object store | **append log, segmented file, Kinesis/Kafka shape** |
| Query primitive | predicate eval | none | **windowing + replay + compaction** |

## Current state

- `@noy-db/hub/history` provides a per-record hash-chained ledger — partial stream semantics, scoped per record
- `withPeriods` time-partitioning provides period-keyed buckets — partial, scoped per collection
- `Collection.scan()` provides cursor-style read — works on records, not stream-shaped
- No first-class `StreamCollection<T>` with append-only construction
- No retention or compaction policy
- No stream-shaped storage backends

## Target state

A `StreamCollection<T>` type alongside `Collection<T>`, with stream-native API (`.append(event)`, `.tail({ from: cursor })`, `.compact({ before: ts })`, `.partition(key)`). Backends opt in via a `shape: 'stream'` capability flag (Dimension 01) and may be append-optimized for free-tier-friendly throughput. Hash-chained ledger and `withPeriods` are *promoted* to use the stream primitive underneath rather than reimplementing the pattern.

## Concrete additions

**Hub primitives:**
- `vault.stream<T>('name', { partitionBy?, retention? })` → `StreamCollection<T>`
- `withStreams()` strategy declaring streams in a vault
- `withRetention({ ttl?, maxBytes?, maxEvents? })` — retention policy per stream
- `withCompaction({ window, mergeFn? })` — snapshot-and-truncate primitive
- `withIdempotenceKey(extractor)` — dedupe on append (Dimension 07 invariant integration)
- `StreamCollection<T>.tail({ from })` returns an `AsyncIterable<Event<T>>` for live consumption
- `StreamCollection<T>.replay({ from, to })` returns deterministic past slice
- `StreamCollection<T>.project({ name, on, into })` — EventStoreDB / KurrentDB-style projections: declare a derived view computed from the stream (`$by_category`, `$by_event_type`); composes with Dim 14 (projections are materialized views over streams)
- Op-log-shaped CRDT mode (Automerge lineage): `StreamCollection<Op>` where each event is an op rather than a state — pairs natively with `withCRDT`

**Stream-shaped storage backends (free-tier-aligned where possible):**
- `to-stream-file` — append-optimized local file with rotating segments (USB / disk; no service dependency)
- `to-stream-s3` — manifest object + part objects; S3-compatible (R2, Backblaze B2, Wasabi, Storj)
- `to-stream-d1` — Cloudflare D1 with append + TTL trigger pattern; free-tier viable
- `to-stream-redis-streams` — Redis Streams; Upstash free tier, Redis Cloud 30MB free
- `to-stream-upstash-kafka` — Upstash Kafka free tier (10K msgs/day) — flag as paid-leaning
- `to-stream-kinesis` — AWS Kinesis; flag explicitly as paid (no free tier) — included for completeness, not mission-aligned

**Stream-native exports (Dimension 03 retrofit):**
- `as-ndjson` — already stream-friendly; confirm `from*` reader supports stream-collection import
- `as-parquet` — rolling segments per retention window
- New: `as-csv-rolling` — segment-by-segment CSV for accounting / regulatory archives

**Stream-specific metering (Dimension 06 retrofit):**
- Events/sec, bytes/sec, retention size, consumer lag, partition skew, segment-rotation rate

## Non-goals & tradeoffs

- **Distributed-log durability guarantees (Kafka-class).** We're SME-scale; best-effort + retention bound is the floor.
- **Message-broker semantics (ack/nack/redelivery, consumer groups).** That's `by-pubsub`'s territory (Dimension 05); streams are durable storage, transports are delivery.
- **Sub-millisecond append latency.** Streams are durable-append; live ephemeral updates use `by-*` transports.
- **In-stream schema evolution.** Events are typed once at append. Schema migrations apply to *new* events; old events stay in their original shape (with a documented migration path via compaction-rewrite if needed).

## Hard tradeoff: encryption granularity

Streams force a choice the record layer doesn't:

- **(a) Per-event encryption.** Each appended event is its own envelope with its own IV. Preserves the zero-knowledge invariant cleanly. Cost: per-event metadata overhead (~50 bytes) noticeable at high event rates.
- **(b) Per-segment encryption.** Events accumulate in a segment, then the whole segment is encrypted on rotation. More efficient. Cost: a partial-write lands plaintext-in-memory longer; segment boundary is a re-encrypt point on compaction; replay reads must decrypt whole segment.

This file picks **(a) per-event** as the default for the same reason records use per-record envelopes — predictable security envelope, no segment-boundary edge cases. Backends advertising `shape: 'stream'` may *also* declare `streamEncryption: 'per-segment'` for high-throughput scenarios; user opts in explicitly with documented loss.

## Dependencies / sequencing

- `withHistory` ledger primitive promoted to use the stream primitive (refactor, not new code) — must be backward-compatible at envelope level
- `withPeriods` continues as a time-partitioning sugar layered atop streams
- Capability metadata `shape: 'stream'` extension in Dimension 01
- Stream metering signals integrated into `to-meter` v2 (Dimension 06)
- Domain primitives `withIdempotenceKey` and `withOrdering` (Dimension 07)

## Cross-references

- `features.yaml` → propose new `stream_collections` section parallel to `features`; storage backends register under `adapters` with `shape: 'stream'` capability
- Related: Dimension 01 (`to-stream-*` backends), Dimension 03 (`as-ndjson` / `as-parquet` rolling), Dimension 05 (`by-walkie` is stream-burst transport; `by-pubsub` is delivery), Dimension 06 (stream metering), Dimension 07 (ordering / idempotence invariants), Dimension 11 (compaction is one form of garbage collection)
- Spec anchor: new `SUBSYSTEMS.md#streams` section

## Open questions

- **Type ergonomics.** `StreamCollection<T>` separate type, or `Collection<T>` with a `stream: true` flag and narrowed methods? Separate type is clearer; flag is less-API-surface.
- **Ledger promotion path.** When the existing per-record ledger is rewritten atop streams, do existing vaults need migration, or does the wire-format envelope already accommodate?
- **Query DSL extension.** `vault.stream('events').query().since(t).where(...).tail()` — what's the windowed-aggregate grammar? Do `.aggregate()` / `.groupBy()` extend cleanly, or do we introduce `.window({ size, slide })`?
- **Compaction interaction with `withHistory`.** If both apply (compact a stream that has its own history), what's the collapse rule?
- **Replay determinism with random IVs.** Per-event encryption uses random IVs; replays produce identical plaintext but the on-disk bytes differ. Is the audit guarantee "plaintext replay deterministic" or "ciphertext replay deterministic"?
- **Free-tier reality check.** Honest stream backends in the SME mission: `to-stream-file` (free), Cloudflare D1 (free, retention via TTL trigger), Upstash Redis Streams (free 30MB), Upstash Kafka (free 10K msgs/day). Kinesis/MSK are paid — do we ship them at all, or only document the alternatives?
- **Cross-stream queries.** Joining a stream against a record collection — what's the contract? (Probably: records snapshot at stream-event time.)
