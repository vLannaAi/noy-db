# Issue #132 — feat(core): CRDT mode — per-collection lww-map / rga / yjs option

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.9.0
- **Labels:** type: feature, area: core

---

## Summary

Optional CRDT semantics per collection for collaborative editing without sync conflicts.

## Proposed API

```ts
const notes = company.collection<Note>('notes', {
  crdt: 'lww-map',  // each field is a last-write-wins register
  // crdt: 'rga',   // sequence CRDT for ordered lists / text
  // crdt: 'yjs',   // Yjs Y.Doc per record (see @noy-db/yjs)
})
```

## Modes

- `'lww-map'` — per-field LWW registers. Commutative. Simple.
- `'rga'` — Replicated Growable Array for ordered list fields. Collaborative ordering.
- `'yjs'` — full Yjs Y.Doc embedded in the record. Rich text, maps, arrays. Requires `@noy-db/yjs`.

## Design notes

- CRDT mode is opt-in; default is LWW at the record level (existing behavior).
- The encrypted envelope wraps the CRDT state (not the resolved snapshot). Adapters see only ciphertext.
- `collection.get(id)` returns the resolved snapshot. `collection.getRaw(id)` returns the CRDT state for merge ops.
- Per-locale CRDT merging of `i18nText` fields (v0.8) uses `lww-map` under the hood.

## Related

- `@noy-db/yjs` (separate issue for Yjs interop package)
- Pluggable conflict policies issue (prerequisite — sets the conflict surface)
