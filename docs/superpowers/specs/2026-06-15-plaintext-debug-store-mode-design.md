# Plaintext / debug store mode — directly-inspectable store contents

- **Date:** 2026-06-15
- **Status:** Design / proposed
- **Related:** as-aws-s3 direct-serve (sibling spec, same date), [[per-blob-cek-design]]

## 1. Problem & goal

When debugging, you want to point **store-native tooling** at the data — `jq` over JSON files, the S3 console, a DynamoDB browser, a SQLite viewer — and **read the actual records**, not ciphertext. noy-db already has an unencrypted mode (`encrypt: false`), so the user's intuition is correct that "we may already have the feature." This spec asks: *how close is it, what's the gap, and how do we make it a first-class, clearly-fenced **debug mode**?*

## 2. What exists today (verified)

`encrypt: false` is real and threads through ~13 branch points (`noydb.ts`, `vault.ts`, `collection.ts`). In plaintext mode:

- A record envelope is stored as:
  ```json
  { "_noydb": 1, "_v": 1, "_ts": "2026-06-15T…Z", "_iv": "", "_data": "{\"name\":\"Alice\"}", "_by": "alice" }
  ```
  i.e. `_data` is a **plain JSON string** (no base64, no ciphertext), `_iv` empty. This **is** directly readable — but the record is a **stringified JSON nested inside the envelope**, so native tools need an unwrap step (`jq -r '._data | fromjson'`).
- **Blobs are still chunked + gzipped** even in plaintext mode (only the encryption is skipped). So a blob is not openable as a file from the store.

So the gap is: (a) the record is wrapped + double-encoded, and (b) blobs aren't legible.

## 3. Design

### 3.1 A named, gated mode

Introduce `debugPlaintext: true` as an explicit vault option, **only valid when `encrypt: false`**. It is never a default and never silently combinable with encryption (see §4). It changes *how plaintext data is laid out in the store* to maximize native legibility.

### 3.2 Record layout — three options

| Option | Layout | Pros | Cons |
|---|---|---|---|
| **A. Documented unwrap** (no code) | keep current envelope; ship a `jq` filter + tiny CLI (`noydb cat`) | zero risk, zero new branches | not *directly* legible; needs the helper |
| **B. Debug envelope** (recommended) | inline record fields beside metadata: `{ "_noydb":1, "_v":1, "_ts":"…", "_by":"alice", "name":"Alice" }` | `jq '.name'` just works; one object | field-name collision with reserved `_`-prefixed keys → needs namespacing |
| **C. Raw record** | store the bare record, drop the envelope | maximally clean | loses `_v`/`_ts`/`_by` → breaks OCC, history, audit |

**Recommendation: Option B**, with all noy-db metadata kept under the reserved `_`-prefix (record fields are validated to not collide; `_data` is removed). This preserves versioning/audit while making `jq`/console reads trivial. Reads transparently re-assemble the record by stripping `_`-prefixed keys.

### 3.3 Blob legibility

In `debugPlaintext` mode, public-style raw-object writing applies to **all** blob fields: **skip gzip, skip chunk-encryption, write one raw object** with a sensible extension. This is the **same raw-object path** the `as-aws-s3` spec needs — build it once, share it. Result: a blob is a real file/object you can open directly from the store.

## 4. Security — hard guardrails (non-negotiable)

Debug mode means *the store sees everything in plaintext*. It must be impossible to footgun:

- **Encrypt-coupling guard:** `debugPlaintext: true` with `encrypt: true` (or a non-null secret) is a **hard error at vault open**, not a warning.
- **Loud + opt-in:** opening a vault in debug mode emits a prominent warning; never inferred, never defaulted.
- **CI/lint guard:** an architecture-check rule flags `debugPlaintext: true` anywhere outside `__tests__` / `showcases` / explicitly-marked dev config, so it can't reach production unnoticed.
- **Client-data discipline:** docs state plainly — never for client PII outside a local/throwaway dev vault. (Cross-reference client-privacy posture.)

## 5. Why this is foundational

Both the `as-aws-s3` direct-serve feature and any future `as-*` live projection rest on two capabilities defined here: (1) a **plaintext, envelope-free record layout** the store can read, and (2) a **raw-object blob path**. Landing debug mode first gives the `as-*` projections a tested foundation and a single place where the "store sees plaintext" carve-out is defined and audited.

## 6. Phasing

- **P1:** `debugPlaintext` option + encrypt-coupling hard error + Option-B record layout (read/write) + warning.
- **P2:** raw-object blob path (shared with `as-aws-s3`).
- **P3:** `noydb cat`/unwrap helper, CI guard rule, docs + showcase.

## 7. Open questions

1. Reserved-prefix collision policy: reject on write, or auto-escape a colliding user field?
2. Should debug mode also drop the `_dict_*` / `_blob_index` internal collections into a more legible shape, or leave internals as-is?
3. Is a read-only "inspect" variant useful (decrypt-on-the-fly to a plaintext mirror) for vaults that must stay encrypted at rest but need a momentary debug view?
