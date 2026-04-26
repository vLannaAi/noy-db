# shadow

> **Subpath:** `@noy-db/hub/shadow`
> **Factory:** `withShadow()`
> **Cluster:** E — Snapshot & Portability
> **LOC cost:** ~129 (off-bundle when not opted in)

## What it does

Read-only "frame" view of a live vault. Every read on `vault.frame()` delegates to the underlying collection; every write throws `ReadOnlyFrameError` with a message naming the attempted op. Frames are views, not snapshots — reads reflect the current state of the vault at read time.

## When you need it

- Screen-sharing a live vault during a demo
- Compliance review where the reviewer must not be able to edit
- Testing harnesses that want to assert read-only access
- Wrapping a vault before passing it into untrusted callsites

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withShadow } from '@noy-db/hub/shadow'

const db = await createNoydb({
  store: ...,
  user: ...,
  shadowStrategy: withShadow(),
})
```

## API

```ts
const frame = vault.frame()
const inv = await frame.collection<Invoice>('invoices').get('inv-1')
const list = await frame.collection<Invoice>('invoices').list()

await frame.collection<Invoice>('invoices')
  .put('inv-1', { ... })  // → throws ReadOnlyFrameError('put()')
```

## Behavior when NOT opted in

- `vault.frame()` throws with a pointer to `@noy-db/hub/shadow`

## Pairs well with

- **history** — `vault.at(timestamp)` returns a `VaultInstant`, which is the time-traveling cousin of a frame

## Edge cases & limits

- Frame is a JavaScript-layer guard, not a cryptographic boundary — the keyring DEKs are unchanged. A hostile caller in the same process could bypass the frame by accessing the underlying vault directly
- Frames are cheap to construct; create one per code-path that should be read-only

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/vault-frame.test.ts`
