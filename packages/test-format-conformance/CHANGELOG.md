# @noy-db/test-format-conformance

## 0.7.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.12

## 0.7.0-pre.11

### Patch Changes

- READMEs now document the API that exists (#1252). Every fenced example in
  shipped prose compiles against the built `dist`, enforced by
  `check:prose-examples`.

  The two that were more than renames:

  - **on-recovery**: the README taught the KEK-wrapping architecture removed in
    the tier-2 wrap-DEKs unification (`0.1.0-pre.8`, #42) — `unwrapKEKFromRecovery`,
    `wrapKEKForRecovery`, `kek:` option, `_recovery_<N>` keyring entries, and a
    40-line manual unlock loop, none of which exist. Rewritten to the real flow:
    `generateRecoveryCodeSet({ deks })` → `db.team.enrollRecovery` →
    `db.recoverSecret` (which burns and auto-rotates), with a History note on why
    there is no KEK path.
  - **in-vue**: `enrollBiometric`/`unlockWithBiometric` never existed in any
    version. The section now teaches `@noy-db/on-webauthn`'s real API, which is
    framework-neutral and called from Vue directly.

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.11

## 0.7.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.9

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
