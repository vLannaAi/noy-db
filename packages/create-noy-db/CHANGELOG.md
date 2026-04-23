# @noy-db/create

## 0.10.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.11.0
  - @noy-db/to-file@1.0.0
  - @noy-db/to-memory@1.0.0

## 0.8.1

### Patch Changes

- feat(v0.9): sync v2 — conflict policies, partial sync, transactions, CRDT, presence, @noy-db/yjs

  ### @noy-db/core

  - **#131 `conflictPolicy`** — per-collection conflict resolution: `'last-writer-wins'`, `'first-writer-wins'`, `'manual'`, or a custom merge function. Overrides the db-level `conflict` option.
  - **#132 CRDT mode** — `crdt: 'lww-map' | 'rga' | 'yjs'` on any collection. `collection.getRaw(id)` returns the full `CrdtState`. CRDT conflict resolver auto-merges at the envelope level without the app seeing it.
  - **#133 Partial sync** — `push(comp, { collections })`, `pull(comp, { collections, modifiedSince })`, `sync(comp, { push, pull })`. Adapter may add optional `listSince()` for server-side filtering.
  - **#134 Presence** — `collection.presence<P>()` returns a `PresenceHandle`. `update(payload)` encrypts with an HKDF-derived key (from the collection DEK) and publishes. `subscribe(cb)` delivers decrypted peer snapshots. Real-time via adapter pub/sub; storage-poll fallback for all other adapters.
  - **#135 Sync transactions** — `db.transaction(comp).put(col, id, rec).delete(col, id).commit()`. Two-phase: local writes then `pushFiltered()` for only the transaction records. Returns `{ status, pushed, conflicts }`.

  ### @noy-db/yjs (new package)

  - `yjsCollection(comp, name, { yFields })` — wraps a `crdt: 'yjs'` collection with Y.Doc-aware API
  - `getYDoc(id)` — decode stored base64 update into a Y.Doc with declared fields initialised
  - `putYDoc(id, doc)` — encode Y.Doc state and persist as encrypted envelope
  - `applyUpdate(id, bytes)` — merge a Yjs update into an existing record
  - `yText()`, `yMap()`, `yArray()` field descriptors

- Updated dependencies
  - @noy-db/core@0.9.0
  - @noy-db/memory@1.0.0
  - @noy-db/file@1.0.0

## 0.7.1

### Patch Changes

- Updated dependencies [29c54c4]
- Updated dependencies [29c54c4]
  - @noy-db/core@0.8.0
  - @noy-db/file@1.0.0
  - @noy-db/memory@1.0.0

## 0.6.1

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0
  - @noy-db/file@1.0.0
  - @noy-db/memory@1.0.0

## 0.6.0

### Patch Changes

- Updated dependencies [755f151]
- Updated dependencies [92f2000]
- Updated dependencies [36dbdbc]
- Updated dependencies [f968f83]
- Updated dependencies [bd21ad7]
- Updated dependencies [d90098a]
- Updated dependencies [958082b]
- Updated dependencies [f65908a]
  - @noy-db/core@0.6.0
  - @noy-db/file@1.0.0
  - @noy-db/memory@1.0.0

## 0.5.0

### Initial release

Wizard + CLI tool for `noy-db`. Invoke via `npm create @noy-db` (or the `pnpm` / `yarn` equivalent) to scaffold a fresh Nuxt 4 + Pinia encrypted store, or to patch an existing Nuxt 4 project in place.

**Fresh-project mode.** Prompts for a project name, adapter choice (`browser` / `file` / `memory`), and whether to include sample data. Emits a minimal Nuxt 4 starter with `@noy-db/nuxt` pre-wired, a typed `defineNoydbStore<Invoice>` in `stores/invoices.ts`, and an `index.vue` page that demonstrates reactive reads and writes against the store.

**Augment mode.** Run the wizard from inside an existing Nuxt 4 project root and it detects the project automatically (via `nuxt.config.{ts,js,mjs}` + `package.json`-declared `nuxt` dependency) and patches `nuxt.config.ts` in place using [magicast](https://github.com/unjs/magicast) AST rewriting. Adds `'@noy-db/nuxt'` to the `modules` array, adds `noydb: { adapter, pinia: true, devtools: true }`, preserves unrelated config keys and comments, shows a colored unified diff before any write, and asks for confirmation. Idempotent — re-running on an already-augmented project is a no-op. `--dry-run` prints the diff without writing. `--force-fresh` forces classic fresh-project mode even inside a Nuxt directory.

**Internationalization.** The wizard speaks English and Thai. Pick explicitly with `npm create @noy-db my-app --lang th`, or let the wizard auto-detect from the standard POSIX locale env vars (`LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE`) — a developer who already has `LANG=th_TH.UTF-8` in their shell rc gets Thai automatically with no flag. Validation errors and stack traces stay in English regardless of locale so bug reports are triageable by maintainers who speak either language. Adding a third language is ~30 lines of new code plus a test.

**`noy-db` CLI.** Four subcommands for routine key-management and backup tasks:

- `noy-db verify` — runs the integrity check on a compartment (chain verification + data envelope cross-check).
- `noy-db rotate` — rotates DEKs for one or more collections, re-encrypts every record, and re-wraps the new keys into every user's keyring.
- `noy-db add user <id> <role>` — grants a new user access to a compartment, prompting for the caller's passphrase and then the new user's passphrase.
- `noy-db backup <target>` — dumps a compartment to a local file using the verifiable-backup format. Target accepts `file://` URIs or plain paths. Parent directories are created on demand.

All subcommands use the file adapter, prompt for passphrases via `@clack/prompts` `password()` (never echoes, never logs), and close the `Noydb` instance in a `finally` block to clear the KEK from memory on the way out.

Dependencies: `@clack/prompts`, `picocolors`, `magicast`, `diff`, and the `@noy-db/core`, `@noy-db/memory`, `@noy-db/file` packages at `^0.5.0`.
