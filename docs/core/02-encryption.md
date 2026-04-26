# Core 02 — Encryption

> **Always-on. The non-negotiable trust boundary.**
> Source of truth: `packages/hub/src/crypto.ts`

## What it is

Every record on disk is AES-256-GCM ciphertext. The key hierarchy:

```
Passphrase
   ├─ PBKDF2-SHA256 (600,000 iterations) ──→ KEK (in-memory only)
                                                 │
                                                 └── unwraps DEK per collection (AES-KW, RFC 3394)
                                                       │
                                                       └── encrypts records (AES-256-GCM, fresh 12-byte IV)
```

- **KEK** never persisted; lives only in memory during an active session. `db.close()` zeroes it.
- **DEK** wrapped per user in the keyring file. Rotating a user re-wraps for the remaining members.
- **IV** is a fresh 12-byte random value per encrypt operation. Never reused.

## Envelope format

```json
{
  "_noydb": 1,
  "_v":     3,
  "_ts":    "2026-04-04T10:00:00.000Z",
  "_iv":    "<base64>",
  "_data":  "<base64 ciphertext>"
}
```

`_v` and `_ts` are NOT encrypted — the sync engine needs them without keys. Everything in `_data` IS encrypted.

## Plaintext mode

`createNoydb({ encrypt: false })` skips the crypto path entirely. Records are stored as raw JSON in `_data`. Use only for testing / debugging — no privacy guarantees.

## Zero crypto dependencies

All cryptography uses the Web Crypto API (`crypto.subtle`). No `npm` crypto packages are or ever will be installed. The library audits cleanly against supply-chain risk for cryptographic primitives.

Available in:
- Node.js 18+
- Bun
- Deno
- Modern browsers
- Cloudflare Workers
- Electron / NW.js
- Mobile WebViews

## Critical invariants

These are the bright lines. Any change to one of them is a security review.

| Invariant | Enforcement |
|---|---|
| **Stores see only ciphertext** | Encryption happens in `Collection.put` *before* the adapter call. No code path puts plaintext into a store. |
| **AES-256-GCM with random 12-byte IV per op** | `crypto.ts` generates IVs via `crypto.getRandomValues(new Uint8Array(12))`. Never deterministic. |
| **PBKDF2-SHA256 600,000 iterations** | `deriveKey()` constant. Lowering this is a breaking security change. |
| **AES-KW for DEK wrapping** | Standard RFC 3394. No custom KDF. |
| **KEK never on disk** | Only `_keyring/<user>` records persist (which carry wrapped DEKs, not the KEK). |
| **Authenticated decryption fails closed** | A modified envelope throws `TamperedError`; no partial-decryption fallback. |

## See also

- [Core 03 — Stores](./03-stores.md) — the contract that holds these invariants in place
- `SECURITY.md` — disclosure policy
- [SPEC.md](../../SPEC.md) — placeholder skeleton; full spec deferred per #289
