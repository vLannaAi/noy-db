# Issue #100 — feat(core+file): .noydb container format — magic header + opaque handle + compressed body

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.6.0
- **Labels:** type: feature, area: core, area: adapters

---

## Target packages

`@noy-db/core` (primary — container read/write primitives), `@noy-db/file` (emits/consumes `.noydb` files)

## Spawned from

Discussion #92 — `.noydb` container format. Full design rationale, threat-model discussion, and header-field justification live there.

## Problem

`compartment.dump()` at `packages/core/src/compartment.ts:416` already produces a self-contained, tamper-evident, encrypted backup of an entire compartment. It is ~95% of a portable file format already — it just isn't packaged as one. Consumers who want to hand a compartment to another device today end up base64-encoding JSON blobs with ad-hoc filenames, which (a) leaks business metadata through filenames, (b) has no magic-bytes integration with OS file-type systems, and (c) misses an easy 30–50% compression win on the JSON scaffolding.

## Scope (v1)

- **Define the `.noydb` container format v1:**

  ```
  ┌──────────────────────────────────────────────┐
  │ Offset  Length  Field                        │
  ├──────────────────────────────────────────────┤
  │ 0       4       Magic: 'NDB1' (ASCII)        │
  │ 4       1       Flags                        │
  │                   bit 0: compressed          │
  │                   bit 1: has integrity hash  │
  │                   bits 2-7: reserved         │
  │ 5       1       Compression algorithm        │
  │                   0 = none, 1 = gzip, 2 = brotli │
  │ 6       4       Header length (uint32 BE)    │
  │ 10      N       Header JSON (unencrypted)    │
  │ 10+N    M       Body: compressed(dump())     │
  └──────────────────────────────────────────────┘
  ```

- **Minimum-disclosure unencrypted header** — the only fields allowed in the unencrypted header are:
  ```json
  { \"formatVersion\": 1, \"handle\": \"<ULID>\", \"bodyBytes\": 41234567, \"bodySha256\": \"<hex>\" }
  ```
  **Explicitly forbidden in the header:** compartment name, exporter user ID, export timestamp, KDF parameters, user ID hints, \"can be opened by\" lists. Everything human-meaningful lives inside the encrypted body. Enforced by a test that asserts the header JSON shape.

- **Opaque handle (ULID)** — 26-char lexicographically sortable identifier, generated once on first export and persisted in a new reserved internal collection `_meta/handle`. Subsequent exports of the same compartment carry the same handle. Round-trips through `unlock` → `dump` → `load` on a different machine preserve the handle.

- **Compression via Compression Streams API** — native in Node 18+ and every modern browser. **Default: brotli**, fallback to gzip when `DecompressionStream('br')` is unavailable (Safari < 17). Zero new dependencies.

- **Core primitives:**
  - `writeNoydbBundle(compartment, { compression? }): Promise<Uint8Array>` — wraps `compartment.dump()` in the container
  - `readNoydbBundleHeader(bytes): NoydbHeader` — parses header only, never decrypts (backs `noydb inspect`)
  - `readNoydbBundle(bytes, { passphrase }): Promise<Compartment>` — full read + decompress + load

- **File adapter integration** — `@noy-db/file` gets `saveBundle(path, compartment)` / `loadBundle(path)` convenience wrappers.

- **MIME / magic bytes** — registered locally as `application/vnd.noydb.bundle`, magic bytes `NDB1`. Not filed with IANA in v1 — fine for internal use, register when a consumer asks.

## Out of scope (deferred to later milestones)

- **Bundle adapter shape** (Drive / Dropbox / iCloud) — discussion #93, v0.11
- **`noydb inspect` / `noydb open` CLI commands** — v0.10 reader work (discussion #96)
- **Multi-compartment bundles** — single compartment per bundle in v1. Multi is a v2 evolution.
- **Signature flag bit** — reserved, not used in v1.
- **Streaming decompression** for very large bundles on mobile — v2.
- **ZIP-like manifest** with selective extraction — not planned, out of scope for the format.

## Acceptance

- [ ] Container format documented in `docs/noydb-container-format.md` with byte layout, header schema, and compression policy
- [ ] Magic bytes `NDB1`, 10-byte fixed header prefix, uint32-BE header-length field
- [ ] `writeNoydbBundle` / `readNoydbBundle` / `readNoydbBundleHeader` exported from `@noy-db/core`
- [ ] Header validator enforces the minimum-disclosure field set (test fails if unknown fields are written)
- [ ] ULID handle generated on first export, persisted in `_meta/handle`, stable across export / unlock / re-export
- [ ] Brotli default with gzip fallback detected at runtime via `DecompressionStream` feature test
- [ ] Round-trip test: `writeNoydbBundle` → `readNoydbBundle` on three sample compartments (small, medium, Unicode/Thai heavy)
- [ ] Integrity test: flip one byte in the body, assert `BundleIntegrityError`
- [ ] `@noy-db/file` `saveBundle` / `loadBundle` helpers with temp-directory integration tests
- [ ] Changeset (`@noy-db/core: minor`, `@noy-db/file: minor`)
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] No new crypto dependencies — compression ≠ encryption
- [x] Body is ciphertext-then-compress (no CRIME/BREACH exposure — no mixed attacker+secret plaintext, no TLS session reuse)
- [x] Adapters never see plaintext — unchanged, bundle contents are the existing encrypted `dump()` output
- [x] KEK never persisted; decryption of a bundle requires the passphrase, same as `load()`
- [x] Adapter contract unchanged

## Related

- Discussion #92 (source)
- Discussion #93 — bundle adapter shape (v0.11, consumes this)
- Discussion #94 — @noy-db/drive (v0.11, consumes this)
- Discussion #96 — reader CLI + extension (v0.10, consumes this)

v0.6.0.
