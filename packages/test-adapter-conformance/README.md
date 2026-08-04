# @noy-db/test-adapter-conformance

The parameterized store-contract conformance suite for [noy-db](https://github.com/vLannaAi/noy-db)
adapters — **every `NoydbStore` implementation must pass it**, in this repo, in `noy-db-to`, and
out-of-tree.

```ts
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toMyBackend } from '../src/index.js'

runStoreConformanceTests('to-my-backend (mock)', async () => toMyBackend({ client: mockClient() }))
```

`runStoreConformanceTests(name, factory, cleanup?)` registers a vitest `describe` block covering:
basic CRUD, optimistic concurrency (`expectedVersion` → `ConflictError`), bulk `loadAll`/`saveAll`,
vault/collection isolation, edge cases (Unicode ids, 1 MB envelopes, `_del` markers), internal
`_`-collection filtering, and the optional-capability contract — including the
*declared ⇔ implemented* biconditional for `txAtomic` and behavioral `tx()` tests
(rollback-on-failure, atomic `expectedVersion` enforcement).

## Peer dependencies

- `vitest` ^3 — the suite registers vitest tests; call it from a vitest test file.
- `@noy-db/hub` — the store contract (`@noy-db/hub/to`) the suite asserts against.

## License

[MIT](./LICENSE) © vLannaAi
