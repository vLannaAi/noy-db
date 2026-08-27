# @noy-db/test-format-conformance

## 0.7.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.8

## 0.7.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.6

## 0.7.0-pre.5

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.5

## 0.7.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.4

## 0.7.0-pre.3

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.3

## 0.7.0-pre.2

### Minor Changes

- **The conformance kit covers both entry-point shapes and both gates (#1209).**

  `0.7.0-pre.0`'s `/as` inversion silently blinded `@noy-db/test-format-conformance`:
  it denied by proxying the vault, which the inverted method-on-vault shape
  (`vault.export(asCsv())`) bypasses — `this` inside `Vault.export` is the real,
  unproxied object. The four inverted formats' fixtures had been deleted rather
  than migrated, so coverage dropped from nine formats to five with nothing
  turning red.

  The kit now **patches the instance** instead: own-property assignment shadows
  the prototype method at call time, intercepting the argument shape, the
  inverted shape, and hub's internal delegation. Denials are matched on the
  kit's own error class rather than "it threw", every entry point gets an
  ungated-success guard, and the **import gate (`assertCanImport`) is covered
  for the first time** — a format shipping a `decode` with no declared import
  entries gets a loud `SKIPPED` line.

  All four fixtures are restored, and a new architecture rule
  (`as-conformance-fixture`) makes a silent fixture deletion impossible.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.2

## 0.7.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.1

## 0.7.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.0
