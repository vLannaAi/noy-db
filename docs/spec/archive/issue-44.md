# Issue #44 — Delta history via RFC 6902 JSON Patch

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.4.0
- **Labels:** type: feature, release: v0.4, area: core

---

Part of #41 (v0.4 epic).

## Scope

Replace the current \"every mutation = full snapshot\" history with delta-encoded history using RFC 6902 JSON Patch. Each ledger entry (#42 or whatever the ledger issue number turns out to be) references a delta payload instead of a full snapshot. Add \`compartment.pruneHistory({ keepLast })\` to fold old deltas into a new base snapshot.

## Why

A single 10KB record edited 1000 times currently costs ~10MB of history. With deltas it's ~1MB or less, depending on edit size. Storage scales with change size, not record size.

## Technical design

- New module \`@noy-db/core/src/ledger/delta.ts\` with \`computeDelta(prev, next): JsonPatch\` and \`applyDelta(base, patch): T\`.
- Use a tiny hand-rolled JSON Patch implementation — no runtime deps. The ops we need are limited: add, remove, replace, move, copy. Test.
- Ledger entries add \`deltaHash\` alongside \`payloadHash\`. Delta payload is stored as a separate encrypted blob in \`_ledger/\`.
- \`pruneHistory({ keepLast: N })\` reads the last \`N\` entries, computes the snapshot at entry \`len - N\`, writes it as a new base, deletes the older deltas, and appends a \`{ op: 'prune' }\` entry to the chain.
- Prune is idempotent and safe to interrupt (two-phase: write the new base, then delete the old entries; crash-after-write leaves a recoverable state).

## Acceptance criteria

- [ ] Core \`computeDelta\`/\`applyDelta\` pair with at least 15 unit tests (add, remove, replace, move, copy, roundtrip on random objects)
- [ ] History entries store deltas instead of full snapshots
- [ ] \`pruneHistory({ keepLast: N })\` produces a correct base snapshot and leaves the ledger chain valid
- [ ] Benchmark: 1K edits of a 1KB record uses <10KB of history storage (vs ~1MB for full snapshots)
- [ ] Integration test: edit → revert through deltas works for at least 100 edits
- [ ] CHANGELOG entry

## Estimate

M

## Dependencies

- Blocked by: hash-chained ledger (they share storage format)
