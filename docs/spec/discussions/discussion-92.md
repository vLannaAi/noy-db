# Discussion #92 — .noydb container format: wrapping compartment.dump() with an opaque-handle header

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **State:** closed
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/92

---

`compartment.dump()` at `packages/core/src/compartment.ts:416` already produces a self-contained, tamper-evident, encrypted backup of an entire compartment: keyrings, collections, internal ledger chain, head hash. It's ~95% of a portable file format already. It just isn't packaged as one.

Proposal: define **`.noydb`** as a thin container wrapping the existing `dump()` output, with a magic number, an unencrypted metadata header (carrying **only an opaque handle**), and a compressed body. This is a prerequisite for the bundle adapter discussions (Drive, Dropbox, iCloud) but it's also valuable on its own — the `file` adapter and the CLI can emit/consume `.noydb` files immediately for USB backup, export, transport, and cross-device restore.

## Why `.noydb` and not `.noy`

`.noy` is **already taken** by an existing third-party "NOY Backup Utility" (see fileinfo.com / fileproinfo.com listings). Using `.noy` would create:

- File-manager confusion ("which app opens this?")
- Mime-type collisions when registering with OS or Drive
- Search-result pollution for users looking for our format

`.noydb` is the natural alternative: matches the package namespace (`@noy-db/*`), is essentially unclaimed, and is unambiguous about what's inside.

## Why a container, not just raw `dump()` JSON

1. **OS / Drive / file-manager integration.** Magic bytes let `file(1)`, Drive's content inspector, Android's intent resolver, and macOS's Uniform Type Identifier system recognize `.noydb` without trusting the extension.
2. **Reader-friendly preview, without leaking business metadata.** A reader UI should be able to confirm "this is a NOYDB bundle, version 1, ~12 MB compressed" *before* prompting for the passphrase. But it must not leak the compartment name, the exporter user ID, or the export timestamp — those are business-sensitive (client identity, org structure, operational pattern).
3. **Compression.** A raw `dump()` is pretty-printed JSON with base64-encoded ciphertext. Brotli on that shape typically wins 30–50% — not because the ciphertext compresses (it doesn't) but because the JSON scaffolding, field names, and base64 padding do.
4. **Format evolution.** A magic number + version field means future changes ship without guessing whether a legacy file is one or the other.

## Proposed container

```
┌──────────────────────────────────────────────┐
│ Offset  Length  Field                        │
├──────────────────────────────────────────────┤
│ 0       4       Magic: "NDB1" (ASCII)        │
│ 4       1       Flags                        │
│                   bit 0: compressed          │
│                   bit 1: has integrity hash  │
│                   bits 2-7: reserved         │
│ 5       1       Compression algorithm        │
│                   0 = none                   │
│                   1 = gzip                   │
│                   2 = brotli                 │
│ 6       4       Header length (uint32 BE)    │
│ 10      N       Header JSON (unencrypted)    │
│ 10+N    M       Body: compressed(dump())     │
└──────────────────────────────────────────────┘
```

## The unencrypted header — minimum disclosure principle

```json
{
  "formatVersion": 1,
  "handle": "01HXG4F5ZK7QJ8M3R6T9V2W0YN",
  "bodyBytes": 41234567,
  "bodySha256": "<hex of body before decompression>"
}
```

That is **the entire header**. Specifically:

- ✅ `handle` — an opaque, library-generated identifier (proposal: ULID — 26 chars, lexicographically sortable, no business meaning). Generated once when a compartment is first exported and persisted in the compartment's `_internal` collection so subsequent exports of the same compartment carry the same handle.
- ✅ `formatVersion` — needed for parser dispatch.
- ✅ `bodyBytes` / `bodySha256` — let the reader integrity-check before decompression and refuse to decode an obviously-corrupted file.
- ❌ Compartment name — leaks client identity.
- ❌ Exporter user ID — leaks org structure.
- ❌ Export timestamp — leaks operational pattern (when do they back up, how often).
- ❌ KDF parameters (salt, iterations) — even though these are technically not secret, exposing them outside the encrypted body gives an offline attacker a head start. Stays inside the encrypted keyring as today.
- ❌ User ID hints / "this can be opened by" lists — leaks who works at the org.

**Everything human-meaningful lives inside the encrypted body.** The header tells the reader "this is bundle 01HXG4F5ZK7QJ8M3R6T9V2W0YN, NOYDB format v1, 41 MB body." Nothing more. Until the user provides the passphrase, nothing about *what* the bundle contains is revealed.

The reader UI shows the handle (truncated, like Git short SHAs: `01HXG4F5…`) so a user with multiple bundles can pick the right one based on filename + handle, without the file itself betraying anything.

## Compression choice

Compression Streams API is native in Node 18+ and every modern browser. Zero dependency added.

| Algorithm | Size on sample (10k records) | Decompress time (browser) | Notes |
|---|---|---|---|
| none | 42 MB | — | baseline |
| gzip | 28 MB | ~120 ms | universal support |
| brotli | 23 MB | ~180 ms | no Safari < 17 via `DecompressionStream('br')` |

**Default: brotli.** Fallback to gzip automatically when `DecompressionStream('br')` is unavailable. Detected at runtime.

## Safety property: compressing encrypted data

Compressing around encrypted content is safe in this threat model because there is no mechanism for attacker-controlled plaintext to be mixed with secrets during compression (CRIME/BREACH attacks don't apply — there's no TLS session with mixed attacker+secret inputs being compressed together). The ciphertext is produced first, then compressed; the compression ratio is independent of the key. Worth stating explicitly because "encrypt then compress" is generally discouraged without context.

## CLI and file adapter integration

With `.noydb` defined, the CLI from `ROADMAP.md:448` gets concrete:

```bash
noydb dump my-compartment > 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb
noydb open 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb     # interactive reader
noydb verify 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb   # header + body SHA + ledger head check
noydb inspect 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb  # print header only — never prompts
```

`noydb inspect` is the operationally important one: it lets a user (or a sysadmin auditing a backup directory) confirm a file is a valid `.noydb` bundle without ever decrypting it. Output is the header JSON and nothing else.

## MIME type and extension

- Extension: `.noydb`
- MIME type: `application/vnd.noydb.bundle`
- Magic bytes: `NDB1` (NoyDB Bundle v1)
- Not registered with IANA yet. Fine for internal use; register when a consumer asks.

## Open questions

1. **Handle scheme.** ULID (26 chars, sortable, time-bucketed first half) vs. UUIDv7 (similar properties, more standardized) vs. random base32 (simplest). ULID is my default but not religious.
2. **Handle persistence.** Where does the handle live inside the compartment? Proposal: a single record in a new reserved internal collection `_meta/handle`, written on first export, never rotated. Surviving an `unlock` → `dump` → `load` round-trip on a different machine should preserve the handle.
3. **Should `inspect` print absolutely nothing else?** Even file size? File size is already visible from `ls -l`, so probably fine to include.
4. **Single-compartment or multi-compartment bundles?** Current `dump()` is one compartment per call. Multi-compartment would let a consumer hand one `.noydb` to a second device and get everything. Worth designing the container to allow it, or strict single-compartment from v1?
5. **Reserved flag bits.** Six free. Anticipated uses: signature present, partial export, schema version pinned. Worth pre-allocating semantics now?
6. **Streaming decompression** for very large bundles on mobile, to avoid a 100 MB string in memory. v1 or defer?

## Out of scope for this discussion

- Cloud adapters that consume `.noydb` — sibling discussions.
- Sync scheduling — sibling discussion.
- Reader UX (CLI extension, browser extension, file association) — sibling discussion.


> _Comments are not archived here — see the URL for the full thread._
