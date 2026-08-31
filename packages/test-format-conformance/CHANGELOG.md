# @noy-db/test-format-conformance

## 0.7.0-pre.16

### Minor Changes

- The `as-*` gate kit now observes the STORE rather than a named vault method
  (#1211).

  The before-reading case asserted that `vault.exportStream` was not called — a
  LEXICAL observation. #1209 happened precisely because an API reshape moved the
  gate out of the place the observer was looking, so an observation keyed on a
  method name is blind to the next reshape by construction. It now counts reads
  leaving the injected `NoydbStore`: every record any entry point produces is
  bytes read from the store, whatever shape the API takes.

  **Fixture contract change.** `FormatFixture` gains `observableVault()`, which
  returns the vault together with the store it was built on. Wrap the store with
  the new `observeStore()` export **where the store is created** and pass the
  result to `createNoydb` — a wrapper applied after the vault exists intercepts
  nothing, because the vault captured its store at construction. That fact also
  settles which side owns the wrapper: the kit owns the counting logic (a
  fixture that miscounts would make its own package look conformant), the fixture
  only threads it.

  A fixture without `observableVault` FAILS with a migration message. There is
  deliberately no fallback to the old observation: reverting silently would let a
  package look conformant while watched by the weaker mechanism, with nothing in
  the output saying which one ran.

  The count is windowed around the entry-point call, not totalled. Store reads
  happen at `openVault` (keyring, fence) before any export runs, so a total would
  pass on those alone — that is, on an export that did nothing.

  **A second assertion ships with it, and it is what makes the first mean
  anything:** the ungated call must read the store. Without it, `reads === 0` is
  equally satisfied by an export served from a warm cache or by an entry point
  that reads nothing — both indistinguishable from "the gate refused first".

  All nine `as-*` fixtures are migrated. Mutation-checked: making an entry point
  read one record before the gated export turns the refusal case red
  ("expected 2 to be +0"), which is the exact class #1209 was blind to.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.16

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
