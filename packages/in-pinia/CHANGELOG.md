# Changelog — in-pinia

## 0.2.0-pre.4

### Schema-update forwarding ([#258](https://github.com/vLannaAi/noy-db/pull/258))

- `defineNoydbStore` now forwards `persistJsonSchema` and `schemaUpdate` to the underlying `Collection` (alongside `schema`/`attestation`), so a store-defined collection can opt into the schema-cutover protocol declaratively — no pre-registration `vault.collection(...)` call. Typed off the collection's own options. Closes [#255](https://github.com/vLannaAi/noy-db/issues/255).

## 0.2.0-pre.3

### Attestation field-schema forwarding ([#250](https://github.com/vLannaAi/noy-db/pull/250))

- `defineNoydbStore` now forwards an optional `attestation` field schema to the underlying `Collection` (alongside `schema`), so `vault.issueAttestation(name, id)` works for Pinia-backed collections. Typed off the collection's own option — no new dependency. Stores without it behave exactly as before.

## 0.2.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.2

## 0.2.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.1

## 0.1.0-pre.16

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.16

## 0.1.0-pre.15

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.15
## 0.1.0-pre.14

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


## 0.1.0-pre.9

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.9


## 0.1.0-pre.8

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.8

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0

## 0.1.0-pre.1 — Initial pre-release
