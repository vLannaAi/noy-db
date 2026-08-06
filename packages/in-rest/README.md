# @noy-db/in-rest

[![npm](https://img.shields.io/npm/v/%40noy-db/in-rest.svg)](https://www.npmjs.com/package/@noy-db/in-rest)

> Framework-neutral REST API integration for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/in-rest
```

## What it is

A framework-neutral HTTP server that exposes a noy-db **store** — and nothing more.
`createRestHandler` turns any `NoydbStore` into a single `POST {basePath}/rpc` endpoint
that proxies the six store methods (`get`/`put`/`delete`/`list`/`loadAll`/`saveAll`, plus
optional `ping`/`listSince`/`listPage`/`listVaults`) over the wire. Hono, Express, Fastify,
and Nitro subpath adapters marshal your framework's request/response into it.

**The server only ever sees ciphertext.** It never receives the vault secret, never
unlocks a vault, and never runs a query — it forwards `EncryptedEnvelope`s straight to the
store and returns them unchanged. Unlock, decryption, and the query DSL all happen in the
**client**, exactly as with every other noy-db storage backend. The REST server is a dumb,
untrusted ciphertext relay, consistent with the zero-knowledge model.

The matching client — a `to-rest` `NoydbStore` that POSTs to this endpoint and re-hydrates
`ConflictError` from a `409` — lives in the [`noy-db-to`](https://github.com/vLannaAi/noy-db-to)
companion repo (the `to-*` store family), so it never has to ship here.

## Usage

```ts
import { createRestHandler } from '@noy-db/in-rest'
import { honoAdapter } from '@noy-db/in-rest/hono'

// `store` is any ciphertext NoydbStore (to-file, to-postgres, to-aws-s3, …).
const handler = createRestHandler({
  store,
  // Authorization is FAIL-CLOSED: with no `authorize`, every request is 401.
  // You own the policy — check a bearer token, an mTLS header, a JWT, whatever.
  authorize: (req) => req.headers['authorization'] === `Bearer ${process.env.REST_TOKEN}`,
  // Optional: restrict to a read-only relay.
  // allow: new Set(['get', 'list', 'loadAll']),
})

app.route('/', honoAdapter(handler)) // or expressAdapter / fastifyPlugin / nitroAdapter
```

`RestHandlerOptions`: `{ store, authorize?, allow?, basePath? }`. Success → `200` with the
raw store result; a CAS conflict → `409 { error: { name: 'ConflictError', version } }`;
unauthorized → `401`; unknown/malformed → `400`; disallowed method → `403`.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/in-rest`](https://github.com/vLannaAi/noy-db/tree/main/packages/in-rest)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
