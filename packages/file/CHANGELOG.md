# @noy-db/file

## 1.0.0

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

## 1.0.0

### Patch Changes

- Updated dependencies [29c54c4]
- Updated dependencies [29c54c4]
  - @noy-db/core@0.8.0

## 1.0.0

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0

## 0.6.0

### Minor Changes

- d90098a: feat(core+file): `.noydb` container format — magic header + opaque handle + compressed body (#100)

  New `.noydb` binary container format that wraps
  `compartment.dump()` in a thin minimum-disclosure wrapper, plus
  file-adapter helpers for path-based round-trips.

  ```ts
  import { writeNoydbBundle, readNoydbBundle } from "@noy-db/core";
  import { saveBundle, loadBundle } from "@noy-db/file";

  // Core primitives
  const bytes = await writeNoydbBundle(company);
  const { header, dumpJson } = await readNoydbBundle(bytes);

  // File adapter helpers
  const handle = await company.getBundleHandle();
  await saveBundle(`./bundles/${handle}.noydb`, company);
  const result = await loadBundle(`./bundles/${handle}.noydb`);
  ```

  ## Why a binary container at all?

  `compartment.dump()` already produces a JSON string with encrypted
  records inside. Wrapping it again seems redundant — but the wrap
  is what makes the file safe to drop into cloud storage (Drive,
  Dropbox, iCloud) without leaking the compartment name and exporter
  identity through the cloud's metadata API. The minimum-disclosure
  header is the only thing visible without downloading and
  decompressing the body. The dump JSON inside still contains the
  original metadata, but that's only readable by someone who already
  has the file bytes — the same person who could read the encrypted
  records with the right passphrase.

  ## Format byte layout

  ```
  +--------+--------+--------+--------+
  |  N     |  D     |  B     |  1     |  Magic 'NDB1' (4 bytes)
  +--------+--------+--------+--------+
  | flags  | compr  |  header_length (uint32 BE)            |
  +--------+--------+--------+--------+--------+--------+--------+
  | header_length bytes of UTF-8 JSON header                       ...
  +--------+--------+
  | compressed body bytes                                            ...
  ```

  Total fixed prefix: **10 bytes**. Header JSON is variable length;
  body follows immediately after.

  ## Minimum-disclosure header

  Only **four** allowed keys, validated at parse time:

  ```json
  {
    "formatVersion": 1,
    "handle": "01HYABCDEFGHJKMNPQRSTVWXYZ",
    "bodyBytes": 41234567,
    "bodySha256": "abc123..."
  }
  ```

  **Forbidden** (every key produces a parse error):
  `compartment`, `_compartment`, `exporter`, `_exported_by`,
  `timestamp`, `_exported_at`, KDF params, salt fields, any key
  starting with `_`. The validator allowlist is closed —
  forward-compat extension keys require a format version bump.

  ## Compression

  - **Brotli** when the runtime supports `CompressionStream('br')`
    (Node 22+, Chrome 124+, Firefox 122+) — typically 30-50%
    smaller than gzip on JSON payloads
  - **gzip** fallback elsewhere — always available in Node 18+
  - **none** option for round-trip testing or piping into a
    separately compressed transport

  The algorithm is encoded in the format byte at offset 5, so
  readers handle either transparently. The writer feature-detects
  brotli at runtime and falls back automatically when the user
  passes `{ compression: 'auto' }` (the default). Explicit
  `{ compression: 'brotli' }` throws on unsupported runtimes.

  ## Stable opaque handles via ULID

  Every compartment gets a stable 26-character Crockford base32
  ULID via `compartment.getBundleHandle()`. Generated and persisted
  to a reserved `_meta/handle` envelope on first call, returned
  unchanged on subsequent calls. Survives process restarts (the
  envelope is on the adapter, not in memory).

  The handle is the only identifier in the bundle header — it's
  opaque, doesn't leak compartment names, and is the planned
  primary key for the v0.11 cloud bundle adapters (Drive, Dropbox,
  iCloud).

  The ULID timestamp prefix is observable, but it leaks no more
  than the file's own filesystem mtime would. For use cases that
  need timestamp-free handles, a v2 of the format could specify
  "random portion only" without a format break.

  ## Integrity verification

  The header carries `bodyBytes` and `bodySha256` over the
  **compressed** body bytes (not the decompressed dump). This lets
  `readNoydbBundleHeader()` verify integrity without decompressing
  — useful for fast cloud-side validation. Tampering with any byte
  of the body produces `BundleIntegrityError` on the read path.

  A length mismatch fires before the SHA check (cheaper, more
  actionable error message). Decompression failure after the
  integrity hash passes also surfaces as `BundleIntegrityError` —
  that's a producer bug (wrong algorithm byte written) but the
  end result for the consumer is the same: "the body cannot be
  turned back into a dump."

  ## File adapter helpers

  `@noy-db/file` adds two thin path-based wrappers:

  - `saveBundle(path, compartment, opts?)` — calls
    `writeNoydbBundle()`, ensures parent directories exist via
    recursive `mkdir`, writes the file via `fs.writeFile`
  - `loadBundle(path)` — reads the file via `fs.readFile`, calls
    `readNoydbBundle()`

  Neither wrapper takes a passphrase. Restoring a compartment from
  a bundle is a two-step operation:

  ```ts
  const { dumpJson } = await loadBundle(path);
  await compartment.load(dumpJson, passphrase);
  ```

  This split keeps the bundle module purely a format layer and
  lets the same code feed format inspectors that never decrypt
  anything.

  ## New public surface

  **`@noy-db/core`:**

  - `writeNoydbBundle(compartment, opts?)` — produces container bytes
  - `readNoydbBundle(bytes)` — full read with integrity verification
  - `readNoydbBundleHeader(bytes)` — header-only read, no decompression
  - `BundleIntegrityError` — structured error for tampering / length mismatch
  - `Compartment.getBundleHandle()` — stable ULID generator/getter
  - `generateULID()` / `isULID()` — exposed for testing and external use
  - `hasNoydbBundleMagic()` — fast file-type check
  - Constants: `NOYDB_BUNDLE_MAGIC`, `NOYDB_BUNDLE_PREFIX_BYTES`,
    `NOYDB_BUNDLE_FORMAT_VERSION`
  - Types: `NoydbBundleHeader`, `WriteNoydbBundleOptions`,
    `NoydbBundleReadResult`, `CompressionAlgo`
  - `resetBrotliSupportCache()` — test-only helper to reset feature
    detection

  **`@noy-db/file`:**

  - `saveBundle(path, compartment, opts?)` — write to disk
  - `loadBundle(path)` — read from disk

  ## Out of scope (tracked separately)

  - **Bundle adapter shape** (Drive, Dropbox, iCloud) — v0.11 #93
  - **CLI commands** `noydb inspect/open` — v0.10 #96
  - **Browser extension reader** — v0.10
  - **Multi-compartment bundles** — v2
  - **Streaming decompression** for mobile — v2
  - **ZIP-like selective extraction** — v2
  - **Encrypting the dump body itself** — the body is plaintext
    JSON containing encrypted records; encrypting the JSON wrapper
    would require a second key derivation and is a bigger design
    conversation than v0.6 can host

  ## Tests

  **`@noy-db/core`** (28 tests in `bundle.test.ts`):

  - ULID generator: shape, uniqueness across 1000 calls,
    Crockford alphabet exclusions (I/L/O/U), lexicographic time
    ordering across milliseconds
  - Header validator: minimal valid header accepted, every
    forbidden key rejected with the offending name in the message,
    unsupported `formatVersion` rejected, malformed handle
    rejected, malformed `bodySha256` rejected, negative/non-integer
    `bodyBytes` rejected, encode→decode round-trip
  - Magic byte detection: positive case, several non-bundle prefixes,
    ASCII verification
  - Round-trip with real compartment + memory adapter: small
    compartment, medium (200 records), Unicode (Thai + emoji),
    explicit gzip, no compression
  - `readNoydbBundleHeader()` parses without decompression; throws
    on missing magic and on truncated prefix
  - Integrity tampering: flipping a body byte → `BundleIntegrityError`
    with sha message; truncating the body → `BundleIntegrityError`
    with length message
  - Handle stability: same handle across multiple `getBundleHandle`
    calls; same handle across re-exports of the same compartment;
    same handle across separate noydb instances on the same
    adapter (cross-process); different compartments get different
    handles

  **`@noy-db/file`** (6 tests in `bundle.test.ts`):

  - `saveBundle()` writes a `.noydb` file with the magic prefix,
    `loadBundle()` reads it back with parsed header and dump JSON
  - Creates intermediate parent directories
  - Overwrites an existing file at the same path; the bundle
    handle is stable across re-saves
  - Honors compression options (gzip explicit, auto default)
  - `loadBundle()` throws `BundleIntegrityError` on a tampered
    bundle file
  - Cross-session handle stability — fresh noydb instance over
    the same data directory sees the same persisted ULID

  444/444 core tests passing (416 baseline on main + 28 new bundle).
  6/6 file bundle tests passing.

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

## 0.5.0

### Initial release

JSON file adapter for `@noy-db/core` — maps the noy-db hierarchy to the filesystem:

```
{dir}/{compartment}/{collection}/{id}.json
{dir}/{compartment}/_keyring/{userId}.json
{dir}/{compartment}/_ledger/{index}.json
```

Intended for USB stick workflows, local disk, network drives, or any filesystem-based deployment. Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability and the optional `listCompartments` cross-compartment enumeration capability (reads the base directory and returns every entry that is itself a directory, skipping top-level files like README, .DS_Store, .git). Uses `node:fs/promises` for all I/O — Node 18+ only. Version conflict detection via `expectedVersion` on `put` throws `ConflictError`. Missing directories are created on demand.

Zero runtime dependencies beyond `node:fs`.
