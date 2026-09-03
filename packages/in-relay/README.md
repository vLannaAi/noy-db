# @noy-db/in-relay

> The relay server half for [noy-db](https://github.com/vLannaAi/noy-db) — a frame dispatcher over a **narrowed** store profile.

A relay hosts vaults it cannot read and must not be able to overwrite. This package serves the granular store methods and **structurally omits two**:

| omitted | why |
|---|---|
| `saveAll` | whole-vault replace — a rollback superweapon aimed at the hosts trusting the relay |
| `listVaults` | enumeration is an existence leak; a relay serves vaults the caller already names |

## Why a narrowed TYPE rather than a runtime allowlist

`@noy-db/in-rest` types its `store` as a full `NoydbStore` and gates dispatch with an `allow` set. That is right for `in-rest`, whose job is to serve a whole store. Building a relay that way means handing the handler an object that **carries** `saveAll` and trusting a `Set` not to call it — structural absence downgraded to a runtime allowlist.

Here the store is a `NoydbRelayStore` (`@noy-db/hub/to`), so the excluded members are not on the type and no frame can reach them.

```ts
import { createRelayHandler } from '@noy-db/in-relay'
import type { NoydbRelayStore } from '@noy-db/hub/to'

const handle = createRelayHandler({ store: myStore satisfies NoydbRelayStore })
const result = await handle({ id: '1', method: 'get', args: ['vault', 'invoices', 'inv-1'] })
```

Passing an ordinary full store is fine — it satisfies the narrowed type structurally, and the handler still cannot call what it does not name.

## Unknown, not forbidden

An excluded method is refused as **unknown** (`400`), never as forbidden (`403`). A 403 would confirm the method exists and is merely disallowed here, naming the excluded surface to anyone probing. An excluded name and a name that never existed are indistinguishable in the response.

## Transport-neutral

`createRelayHandler` takes a decoded frame and returns a decoded result, so it can be served over HTTP, a WebSocket, or QUIC without this package knowing which.

## The notify frame — server push, beside the request frame

Every transport in this family is client-pull; a hosted store that knows a record changed had no way to say so. The relay's one server-initiated sentence is a **notify frame**, and it is deliberately small:

```ts
import { createRelayHandler, createRelayNotifier } from '@noy-db/in-relay'
import type { NoydbRelayStore, EncryptedEnvelope } from '@noy-db/hub/to'

const notify = createRelayNotifier()
const handle = createRelayHandler({ store: myStore satisfies NoydbRelayStore, notify })

// Your transport, when an AUTHENTICATED session asks to watch one vault:
const off = notify.subscribe('vault', (frame) => session.send(JSON.stringify(frame)))
// frame: { t: 'notify', seq: 1, vault: 'vault', collection: 'invoices', id: 'inv-1', op: 'put', ts: '…' }
```

| question | answer |
|---|---|
| a third encoding of the store contract? | no — a notification is not a method call; the wire carries requests (`method`), results (`ok`) and this (`t: 'notify'`) |
| what is `seq`? | a **per-subscription** sequence, contiguous from 1 — a gap is detectable; a late joiner starts at 1 |
| what does it carry? | the **address** (`vault/collection/id`), the op, and the envelope's `_ts` (relay clock for a delete). **Never the envelope** — a push is not a write path |
| delivery guarantee? | at-most-once, in order per subscription. On a gap, reconcile with `listSince(vault, collection, lastTs)` — the frame makes polling unnecessary; it is not the source of truth |
| auth? | a subscription names **one vault** (no enumeration by the back door); binding it to an authenticated session is the transport's job |

A failed mutation publishes nothing; a `tx` publishes one frame per op only after the whole batch committed; a subscriber that throws is skipped for that frame and never breaks the write.

## License

MIT © vLannaAi
