# crdt

> **Subpath:** `@noy-db/hub/crdt`
> **Factory:** `withCrdt()`
> **Cluster:** B — Write & Mutate
> **LOC cost:** ~221 (off-bundle when not opted in)

## What it does

Conflict-free replicated data types for collections that need automatic merge semantics. Three modes: `lww-map` (last-writer-wins per field), `rga` (replicated growable array), `yjs` (full Yjs interop via `@noy-db/in-yjs`). Concurrent edits from two devices merge deterministically without lost writes.

## When you need it

- Multi-device personal apps where the same record is edited offline on both
- Real-time collaborative editors (text, lists, structured documents)
- Anything where "two writers, no central coordinator" is the normal case

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withCrdt } from '@noy-db/hub/crdt'

const db = await createNoydb({
  store: ...,
  user: ...,
  crdtStrategy: withCrdt(),
})
```

Declare per-collection mode:

```ts
vault.collection<Note>('notes', { crdt: 'lww-map' })
```

For Yjs, use `yjsCollection` from `@noy-db/in-yjs`:

```ts
import { yjsCollection, yText, yMap } from '@noy-db/in-yjs'

const docs = yjsCollection(vault, 'docs', {
  yFields: { body: yText(), meta: yMap() },
})
```

## API

- LWW-Map / RGA: standard `put` / `get` — the strategy merges on write
- Yjs: `docs.getYDoc(id)` returns a `Y.Doc`; `docs.putYDoc(id, doc)` persists the encoded state

## Behavior when NOT opted in

- A collection declared with `crdt: 'lww-map' | 'rga' | 'yjs'` throws on first mutation with a pointer to `@noy-db/hub/crdt`
- Sync-engine merge (when `withSync()` is enabled but `withCrdt()` is not) throws the same way
- Plain (non-CRDT) collections work unchanged

## Pairs well with

- **sync** — replication preserves CRDT semantics across peers
- **live** (n/a today) — reactive subscriptions on CRDT collections
- **history** — keep an audit trail of merged states

## Edge cases & limits

- LWW per-field uses logical clocks; conflicts are won by higher (actor, counter) tuples
- Yjs documents grow over time; consider periodic snapshot rebases for hot documents
- Yjs interop requires `yjs` as a peer dep on the consumer

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/recipes/realtime-crdt-app.md`
- `__tests__/crdt.test.ts`
- `packages/in-yjs/__tests__/yjs-collection.test.ts`
