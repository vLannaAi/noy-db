# Changelog — to-file

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

## 0.6.0-pre.0

### Minor Changes

- Store-locator seam (L5) — a store can now be reconstructed from serializable data.

  `@noy-db/hub/to` publishes a credentialless, serializable `StoreDescriptor` (`{ kind, class: 'local'|'browser'|'lan'|'cloud', address, options? }`) plus a `createStoreLocator()` registry (`register(kind, factory)` / `resolve(descriptor, { binding?, credentials? })`). Credentials ride a separate `StoreCredentialSource` resolve-time slot and per-device details a separate `binding` slot — never the descriptor, so a pod's storage manifest can name _where_ data lives without embedding a secret. Unknown kinds throw `UnknownStoreKindError`; duplicate registration throws `DuplicateStoreKindError`. The `@noy-db/hub/to` seam adds zero runtime dependencies.

  `@noy-db/to-file` ships the `local`-class reference: `fileStoreDescriptor(dir)`, `fileStoreFactory`, and `registerFileStore(locator)` — a descriptor-constructed store passes the full adapter-conformance contract. Adoption across the remaining `to-*` stores (`to-webdav` lan, `to-aws-s3` cloud, …) is tracked in the noy-db-to companion.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.0

## 0.5.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.5.0

## 0.4.0

### Minor Changes

- Store factories are now named `to<Backend>()`, matching their package (#845).

  | Package                  | Before            | After          |
  | ------------------------ | ----------------- | -------------- |
  | `@noy-db/to-file`        | `jsonFile`        | `toFile`       |
  | `@noy-db/to-memory`      | `memory`          | `toMemory`     |
  | `@noy-db/to-browser-idb` | `browserIdbStore` | `toBrowserIdb` |

  ```diff
  - import { jsonFile } from '@noy-db/to-file'
  - const db = await createNoydb({ store: jsonFile({ dir: './data' }) })
  + import { toFile } from '@noy-db/to-file'
  + const db = await createNoydb({ store: toFile({ dir: './data' }) })
  ```

  The `to` prefix already means "data goes to a backend", so the factory needs no `Store` suffix, and
  the uniform prefix makes the family greppable. The 16 extended stores in `noy-db-to` follow in their
  own pass.

  **Also in `@noy-db/to-memory`:**

  - `clockUncertainty` → **`clockUncertaintyMs`**, and the store clock is now genuinely
    millisecond-based (`Math.max(clock + 1, Date.now())`) rather than a bare tick counter — so the
    unit in the name is true. Ordering remains strictly monotonic.
  - **`txAtomic: true` is now declared.** `tx()` was implemented but the capability was never
    advertised, so the hub would have skipped it the day `transaction.ts` starts delegating. The
    JSDoc claimed `txAtomic: true` while the object never set it. _(That capability belongs to
    `@noy-db/to-memory` only — `to-file` implements no `tx()` and declares no `txAtomic`.)_

  `memoryStore()` (the hub's built-in default) is unchanged and is **not** a duplicate of `toMemory()`
  — see `SERVICES.md` § Satellite family conventions.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0

## 0.4.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.12

## 0.4.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.11

## 0.4.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.10

## 0.4.0-pre.9

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.9

## 0.4.0-pre.8

### Minor Changes

- Store factories are now named `to<Backend>()`, matching their package (#845).

  | Package                  | Before            | After          |
  | ------------------------ | ----------------- | -------------- |
  | `@noy-db/to-file`        | `jsonFile`        | `toFile`       |
  | `@noy-db/to-memory`      | `memory`          | `toMemory`     |
  | `@noy-db/to-browser-idb` | `browserIdbStore` | `toBrowserIdb` |

  ```diff
  - import { jsonFile } from '@noy-db/to-file'
  - const db = await createNoydb({ store: jsonFile({ dir: './data' }) })
  + import { toFile } from '@noy-db/to-file'
  + const db = await createNoydb({ store: toFile({ dir: './data' }) })
  ```

  The `to` prefix already means "data goes to a backend", so the factory needs no `Store` suffix, and
  the uniform prefix makes the family greppable. The 16 extended stores in `noy-db-to` follow in their
  own pass.

  **Also in `@noy-db/to-memory`:**

  - `clockUncertainty` → **`clockUncertaintyMs`**, and the store clock is now genuinely
    millisecond-based (`Math.max(clock + 1, Date.now())`) rather than a bare tick counter — so the
    unit in the name is true. Ordering remains strictly monotonic.
  - **`txAtomic: true` is now declared.** `tx()` was implemented but the capability was never
    advertised, so the hub would have skipped it the day `transaction.ts` starts delegating. The
    JSDoc claimed `txAtomic: true` while the object never set it. _(That capability belongs to
    `@noy-db/to-memory` only — `to-file` implements no `tx()` and declares no `txAtomic`.)_

  `memoryStore()` (the hub's built-in default) is unchanged and is **not** a duplicate of `toMemory()`
  — see `SERVICES.md` § Satellite family conventions.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.8

## 0.4.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.7

## 0.4.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.6

## 0.4.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.5

## 0.4.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.4

## 0.4.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.3

## 0.4.0-pre.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.2

## 0.4.0-pre.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.1

## 0.4.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.0

## 0.3.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0

## 0.3.0-pre.13

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.13

## 0.3.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.12

## 0.3.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.11

## 0.3.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.10

## 0.3.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.9

## 0.3.0-pre.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.8

## 0.3.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.7

## 0.3.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.6

## 0.3.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.5

## 0.3.0-pre.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.4

## 0.3.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.3

## 0.3.0-pre.2

### Minor Changes

- 0.3 version line continues — lockstep with `@noy-db/hub` 0.3.0-pre.2 (describe() group/order metadata, \_history in the .noydb pod; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 version line — lockstep with `@noy-db/hub` 0.3.0-pre.1 (kernel/enclave reorg, family doors, `withX()` service gating; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.1

## 0.2.0-pre.31

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31

## 0.2.0-pre.5

Version-only lockstep bump; no source changes since pre.4.

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

Version-only lockstep bump; no source changes since pre.2.

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
