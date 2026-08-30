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

## License

MIT © vLannaAi
