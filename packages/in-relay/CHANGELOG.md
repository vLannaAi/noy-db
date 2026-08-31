# @noy-db/in-relay

## 0.7.0-pre.16

### Minor Changes

- New package: `@noy-db/in-relay` — the relay server half (#1237).

  A transport-neutral frame dispatcher over a `NoydbRelayStore`. It takes a
  decoded frame `{ id, method, args }` and returns a decoded result, so a caller
  serves it over HTTP, a WebSocket or QUIC without this package knowing which.

  `RELAY_METHODS` is an allowlist **by construction** rather than by filtering:
  `saveAll` and `listVaults` are absent from it because they are absent from the
  store type it dispatches to, so the list cannot drift away from what it can
  actually call.

  An excluded method is refused as **unknown (400), never forbidden (403)**. A 403
  would confirm the method exists and is merely disallowed here, naming the
  excluded surface to anyone probing — an excluded name and a name that never
  existed are indistinguishable in the response. This matches `@doi-db/daemon`,
  which reached the same conclusion independently in its native implementation.

  Errors are forwarded by NAME so a client can re-hydrate a `ConflictError`
  without `instanceof` across the seam — the contract settled in #1218.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.16
