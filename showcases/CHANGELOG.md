# @noy-db/showcases

## 0.2.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31
  - @noy-db/as-blob@0.2.0-pre.31
  - @noy-db/as-csv@0.2.0-pre.31
  - @noy-db/as-json@0.2.0-pre.31
  - @noy-db/as-ndjson@0.2.0-pre.31
  - @noy-db/as-noydb@0.2.0-pre.31
  - @noy-db/as-xlsx@0.2.0-pre.31
  - @noy-db/as-xml@0.2.0-pre.31
  - @noy-db/as-zip@0.2.0-pre.31
  - @noy-db/by-peer@0.2.0-pre.31
  - @noy-db/by-tabs@0.2.0-pre.31
  - @noy-db/in-ai@0.2.0-pre.31
  - @noy-db/in-devtools@0.2.0-pre.31
  - @noy-db/in-nextjs@0.2.0-pre.31
  - @noy-db/in-pinia@0.2.0-pre.31
  - @noy-db/in-react@0.2.0-pre.31
  - @noy-db/in-rest@0.2.0-pre.31
  - @noy-db/in-solid@0.2.0-pre.31
  - @noy-db/in-svelte@0.2.0-pre.31
  - @noy-db/in-tanstack-query@0.2.0-pre.31
  - @noy-db/in-tanstack-table@0.2.0-pre.31
  - @noy-db/in-vue@0.2.0-pre.31
  - @noy-db/in-yjs@0.2.0-pre.31
  - @noy-db/in-zustand@0.2.0-pre.31
  - @noy-db/on-email-otp@0.2.0-pre.31
  - @noy-db/on-magic-link@0.2.0-pre.31
  - @noy-db/on-oidc@0.2.0-pre.31
  - @noy-db/on-password@0.2.0-pre.31
  - @noy-db/on-pin@0.2.0-pre.31
  - @noy-db/on-recovery@0.2.0-pre.31
  - @noy-db/on-threat@0.2.0-pre.31
  - @noy-db/on-totp@0.2.0-pre.31
  - @noy-db/on-webauthn@0.2.0-pre.31
  - @noy-db/to-browser-idb@0.2.0-pre.31
  - @noy-db/to-file@0.2.0-pre.31
  - @noy-db/to-memory@0.2.0-pre.31
  - @noy-db/to-meter@0.2.0-pre.31
  - @noy-db/to-probe@0.2.0-pre.31

## 0.2.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.1

## 0.1.0-pre.16

### Minor Changes

- New showcase `87-noydb-describe.showcase.test.ts` — `noydb describe` bundle audit walkthrough ([#176](https://github.com/vLannaAi/noy-db/issues/176)).

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.16

## 0.1.0-pre.15

### Minor Changes

Two new showcases for pre.15's Dim 14 v2 follow-up ([#167](https://github.com/vLannaAi/noy-db/pull/167)):

- `85-with-multikey-groupby.showcase.test.ts` — variadic `Query.groupBy(...fields)` walkthrough, declaration-order row shape, niwat per-(client, period) monthly-VAT shape ([#166](https://github.com/vLannaAi/noy-db/issues/166))
- `86-with-union-mv.showcase.test.ts` — UNION MV via `unionSources`, per-arm `map`, composed with multi-key groupBy for monthly-VAT across `taxReceipts` + `creditNotes` ([#165](https://github.com/vLannaAi/noy-db/issues/165))

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.15

## 0.1.0-pre.14

### Minor Changes

Four new showcases for Dim 14 v2 ([#155](https://github.com/vLannaAi/noy-db/issues/155)):

- `81-with-mv-eager.showcase.test.ts` — `withMaterializedView` eager refresh, groupBy + sum aggregate, tombstoning, `_materializedFrom` stamp (5 tests)
- `82-with-mv-lazy.showcase.test.ts` — lazy lifecycle, stale-on-source-write, resolve on both `get()` and `list()`, `vault.refreshView`, refresh coalescing (5 tests)
- `83-with-overlay.showcase.test.ts` — `withOverlayedView` base/overlay/predicate read truth table, write routing, `OverlayIdMismatchError` (5 tests)
- `84-with-mv-predicates.showcase.test.ts` — declared deterministic predicates, `queryHash` sensitivity to `hash` bump + `ctx` change, chain composition (4 tests)

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.14

## 0.1.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.12

## 0.1.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.11

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0
  - @noy-db/as-blob@0.1.0
  - @noy-db/as-csv@0.1.0
  - @noy-db/as-json@0.1.0
  - @noy-db/as-ndjson@0.1.0
  - @noy-db/as-noydb@0.1.0
  - @noy-db/as-xlsx@0.1.0
  - @noy-db/as-xml@0.1.0
  - @noy-db/as-zip@0.1.0
  - @noy-db/by-peer@0.1.0
  - @noy-db/by-tabs@0.1.0
  - @noy-db/in-ai@0.1.0
  - @noy-db/in-nextjs@0.1.0
  - @noy-db/in-pinia@0.1.0
  - @noy-db/in-react@0.1.0
  - @noy-db/in-rest@0.1.0
  - @noy-db/in-solid@0.1.0
  - @noy-db/in-svelte@0.1.0
  - @noy-db/in-tanstack-query@0.1.0
  - @noy-db/in-tanstack-table@0.1.0
  - @noy-db/in-vue@0.1.0
  - @noy-db/in-yjs@0.1.0
  - @noy-db/in-zustand@0.1.0
  - @noy-db/on-email-otp@0.1.0
  - @noy-db/on-magic-link@0.1.0
  - @noy-db/on-oidc@0.1.0
  - @noy-db/on-pin@0.1.0
  - @noy-db/on-recovery@0.1.0
  - @noy-db/on-shamir@0.1.0
  - @noy-db/on-threat@0.1.0
  - @noy-db/on-totp@0.1.0
  - @noy-db/on-webauthn@0.1.0
  - @noy-db/to-aws-dynamo@0.1.0
  - @noy-db/to-aws-s3@0.1.0
  - @noy-db/to-browser-idb@0.1.0
  - @noy-db/to-browser-local@0.1.0
  - @noy-db/to-cloudflare-d1@0.1.0
  - @noy-db/to-cloudflare-r2@0.1.0
  - @noy-db/to-file@0.1.0
  - @noy-db/to-memory@0.1.0
  - @noy-db/to-meter@0.1.0
  - @noy-db/to-postgres@0.1.0
  - @noy-db/to-probe@0.1.0
  - @noy-db/to-sqlite@0.1.0
  - @noy-db/to-supabase@0.1.0
  - @noy-db/to-turso@0.1.0
  - @noy-db/to-webdav@0.1.0

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0
  - @noy-db/to-memory@1.0.0
  - @noy-db/to-file@1.0.0
  - @noy-db/to-browser-local@1.0.0
  - @noy-db/to-browser-idb@1.0.0
  - @noy-db/to-aws-dynamo@1.0.0
  - @noy-db/to-aws-s3@1.0.0
  - @noy-db/to-cloudflare-r2@1.0.0
  - @noy-db/to-cloudflare-d1@1.0.0
  - @noy-db/to-supabase@1.0.0
  - @noy-db/to-postgres@1.0.0
  - @noy-db/to-sqlite@1.0.0
  - @noy-db/to-turso@1.0.0
  - @noy-db/to-webdav@1.0.0
  - @noy-db/to-probe@1.0.0
  - @noy-db/to-meter@1.0.0
  - @noy-db/in-vue@1.0.0
  - @noy-db/in-pinia@1.0.0
  - @noy-db/in-yjs@1.0.0
  - @noy-db/in-react@1.0.0
  - @noy-db/in-nextjs@1.0.0
  - @noy-db/in-svelte@1.0.0
  - @noy-db/in-zustand@1.0.0
  - @noy-db/in-tanstack-query@1.0.0
  - @noy-db/in-tanstack-table@1.0.0
  - @noy-db/in-ai@1.0.0
  - @noy-db/in-rest@1.0.0
  - @noy-db/in-solid@1.0.0
  - @noy-db/on-webauthn@1.0.0
  - @noy-db/on-oidc@1.0.0
  - @noy-db/on-magic-link@1.0.0
  - @noy-db/on-recovery@1.0.0
  - @noy-db/on-shamir@1.0.0
  - @noy-db/on-totp@1.0.0
  - @noy-db/on-email-otp@1.0.0
  - @noy-db/on-pin@1.0.0
  - @noy-db/on-threat@1.0.0
  - @noy-db/as-csv@1.0.0
  - @noy-db/as-xlsx@1.0.0
  - @noy-db/as-json@1.0.0
  - @noy-db/as-ndjson@1.0.0
  - @noy-db/as-xml@1.0.0
  - @noy-db/as-blob@1.0.0
  - @noy-db/as-zip@1.0.0
  - @noy-db/as-noydb@1.0.0
  - @noy-db/by-peer@1.0.0
  - @noy-db/by-tabs@1.0.0
