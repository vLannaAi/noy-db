# Changelog — test-adapter-conformance

## 0.6.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.6

## 0.6.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.5

## 0.6.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.4

## 0.6.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.3

## 0.6.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.2

## 0.6.0-pre.1

### Minor Changes

- First publish. The adapter-conformance suite — the store contract every
  `NoydbStore` implementation must pass — moves from a private in-repo test
  harness to a published package, so satellite store repos and out-of-tree
  store authors consume one shared definition of the contract instead of
  vendoring a copy (noy-db-to#19).

  `@noy-db/hub` and `vitest` are peer dependencies; the suite ships as
  built ESM + types.
