# @noy-db/in-relay

## 0.7.0-pre.17

### Patch Changes

- The relay vocabulary was incomplete, and a store capability gap reported as a
  server error. Both found by a consumer's by-hand parity comparison against the
  first publish.

  **`listPage`, `getStoreTime`, `presencePublish`, `estimateUsage` and `tx` are
  now dispatched.** They are members of `NoydbRelayStore` — `Omit` removes only
  `saveAll` and `listVaults` — but were missing from the dispatch list, so they
  were unreachable through a relay. `listPage` is the one that bites: without it a
  client falls back to `loadAll`, which is the regression pagination exists to
  prevent.

  The original comment claimed the list "cannot drift away from the type it
  dispatches to". It had already drifted by five members. **That claim is now
  ENFORCED rather than asserted**: `NOT_RELAYED` names every deliberate exclusion
  and a compile-time check fails the build if a store method appears in neither
  list. Adding a method to the store contract now forces a decision here instead
  of a silent drop.

  Two deliberate exclusions, with reasons:

  - **`presenceSubscribe`** — returns an unsubscribe _function_; unrepresentable
    in a JSON request/response. Server-initiated delivery is a notify frame's job.
  - **`presignUrl`** — hands the caller a URL that fetches the envelope directly
    from the backing store, _around_ the relay, so it survives revocation and
    escapes metering. Excluded on the security argument, not on serialisability.

  **A store lacking an OPTIONAL method now returns 501, not 500.** Previously an
  absent optional method threw `UnknownRelayMethodError` from inside dispatch and
  the catch-all reported it as 500 — a store capability gap misattributed as a
  server fault, two states warranting opposite responses (degrade vs investigate)
  rendered identically. New `UnsupportedRelayMethodError` maps to 501, matching
  `@noy-db/in-rest`'s `UnsupportedMethodError` and an independent implementation
  that reached 501 too.

  The EXCLUDED members stay **400-unknown** and indistinguishable from a typo: 501
  must not become a way to learn which methods were deliberately removed.

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.17

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
