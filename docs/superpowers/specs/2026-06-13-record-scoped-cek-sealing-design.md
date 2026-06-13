# Record-scoped CEK sealing to `at-*` hosts (#306) — design spike

> **Spike, not a build spec.** Step 3 of the CEK security epic [[#357]]. #306 asks for **crypto-level
> least-privilege**: seal exactly ONE record's key to a trusted-compute `at-*` host (e.g. a PDF-render
> Lambda), so the host can decrypt that record and is *cryptographically* denied every other record —
> not merely policy-denied. The per-record CEK foundation (step 1, merged) makes this possible for the
> first time. This doc resolves the architecture, picks a delivery vehicle, and — critically — is honest
> about the **revocation limit** that's inherent to handing a key to a host.

Issue: [#306](https://github.com/vLannaAi/noy-db/issues/306) · Layer: crypto / `at-*` trusted-compute · Status: design, not implemented. Builds on the merged CEK foundation (`docs/superpowers/specs/2026-06-13-per-record-cek-foundation-design.md`) and recipient-target sealing (`2026-05-28-recipient-target-bundle-sealing-design.md`).

## The gap, precisely (current code)

Today an `at-*` host gets a key at **collection granularity or coarser**:
- Managed mode (`createNoydb({ passphraseMode:'managed', sealingKey: awsKmsSealingProvider(...) })`) seals the **vault passphrase** to the host (`team/managed-passphrase.ts` `resolveManagedSecret`). On unseal the host derives the KEK → unwraps **every** collection DEK → can decrypt the **whole vault**.
- `MagicLinkGrantSpec.record?` (`on-magic-link`) exists but is **advisory metadata only** (`team/magic-link-grant.ts:81`) — `writeMagicLinkGrant` wraps the whole **collection/tier DEK**; the `record?` field plays no cryptographic role. The grantee can decrypt every record in that collection.

So "scope" is operational/policy today (`docs/packages/at-hosts.md`: "the safeguard is scope"), **not cryptographic at the record level**. The pilot's PDF-render Lambda must hold `{ sales: 'ro' }` — the whole sales collection DEK — to render one sale.

## What the CEK foundation unlocks

A record now has its own CEK, AES-KW-wrapped under the collection DEK on `_cek` (`crypto.ts` `wrapCek`/`unwrapCek`). The raw CEK is obtainable by the **grantor** (who holds the collection DEK): `getDEK(collection)` → `unwrapCek(env._cek, dek)` → `exportKey('raw', cek)` → 32 bytes. #306 = **seal those 32 raw CEK bytes to the host**, never the collection DEK. The host then holds exactly one record's key.

## Design

### Core: seal the raw CEK, client-side, to a host RecipientSealer
1. **Grantor unwraps client-side.** The granting vault (unlocked) resolves the record's raw CEK as above. The host is **never** given the collection DEK — only the sealed CEK. This is the load-bearing invariant for host-denial (see Hard Problem A).
2. **Seal to the host's recipient identity.** Reuse the existing `RecipientSealer` machinery (`team/managed-passphrase.ts`: `RecipientHint{v,pid,alg,material}`, `sealForRecipient(plaintextBytes, hint)`). It's algorithm-agnostic over bytes — sealing a 32-byte CEK is a drop-in for the credential bytes it seals today. A 32-byte CEK fits RSA-OAEP-2048's ~190-byte limit.
3. **Host unseals + decrypts exactly that record.** The host receives the sealed CEK, unseals it (its private key / KMS), then `decrypt(env._iv, env._data, cek)`. It holds no other key.

### Prerequisite (must land first): `at-*` hosts as RecipientSealers
`at-aws-kms` (and the GCP/Azure trio) implement `SealingKeyProvider` (symmetric seal/unseal) but **NOT `RecipientSealer`** (the recipient-target spec §12 explicitly defers this). Record-scoped sealing to a cloud host needs the host to expose a **recipient public identity** to seal against. For AWS KMS that's an **asymmetric KMS key** + `Encrypt`/`Decrypt` (`RecipientHint.alg: 'kms-encrypt'`, a new union member). **This is the first build slice** — without it, #306 only works against the in-process `MemoryRecipientSealer`, not a real cloud host.

### Delivery vehicle: a new `_meta/sealed-cek/<collection>/<id>/<pid>` envelope
The explorer confirmed **no lightweight sealed-key delivery type exists**; the options are a full bundle (heavyweight; mutually exclusive with extracted-partition), the extract-partition transferKey path (a separate flagged design), or a new thin envelope. **Recommend the thin envelope**, mirroring `_meta/sealed-passphrase`'s `SealedEnvelope{v,_noydb_sealed,pid,payload}`:
- One store record per (collection, record, host pid): `_meta/sealed-cek/<collection>/<id>/<pid>` → `{ v:1, pid, alg, payload: base64(seal({ collection, id, cek, expiresAt })), collection, id, expiresAt }`. The sealed `payload` wraps a **bound struct** (not bare CEK bytes) — see the binding note below; the plaintext `collection`/`id`/`expiresAt` are routing/expiry metadata for the host.
- The host reads its sealed-CEK records (it's authorized to that `_meta` path), unseals, decrypts the referenced record(s). No bundle write.
- A new `vault.sealRecordToHost(collection, id, hostHint, { expiresAt })` grantor API + `vault.revokeSealedRecord(...)`.

### Record-binding + CloudTrail / audit observability
**Record-binding is done IN the sealed payload, not via KMS encryption context.** A true recipient-target sealer uses an **asymmetric** KMS key (the host's private key never leaves KMS), and per the AWS KMS docs **encryption context is NOT supported with asymmetric (or HMAC) KMS keys** — so the `EncryptionContext{collection,id}` AAD-binding idea does not apply here. Instead the grantor **seals a bound struct `{ collection, id, cek, expiresAt }`** (not bare CEK bytes); on unseal the host checks the embedded `collection`/`id` match the record it's about to decrypt and rejects a mismatch → **replay-proof at the host/app layer** (a sealed CEK can't be reused against a different record).

**CloudTrail:** `at-aws-kms` produces a CloudTrail entry per asymmetric `kms:Decrypt` (key ARN, principal, time) — but at **key+principal granularity, not record-level** (no encryption context to carry `{collection,id}`). Record-level audit therefore relies on the **host logging the in-payload `{collection,id}`** it processed. In-process/`MemoryRecipientSealer` and non-KMS hosts get no cloud trail at all (documented boundary). *(A symmetric-KMS variant could use real `EncryptionContext` for KMS-layer record-binding + audit — but loses the per-recipient asymmetry, requires the grantor to hold Encrypt permission on the host's symmetric key, and isn't "recipient-target." Tradeoff noted as an open decision.)*

## Hard problems — confronted honestly

### A. The host-denial guarantee (forward-provable; one residual)
Sealing only the raw CEK gives a **forward** guarantee: the host never receives any other record's CEK, and never the collection DEK, so it is cryptographically denied every other record. Two things must hold for this to be airtight:
- **Never hand the host the collection DEK** — always unwrap client-side and seal raw CEK bytes. (If the host held the DEK it could unwrap any `_cek` AND query the DEK-keyed `_det` blind-equality index across all records — see CEK foundation §1. So: raw-CEK-only, no DEK.)
- **`_det` residue:** even record-scoped, the host with one CEK can decrypt one body; it cannot use `_det` (that needs the DEK it doesn't have). ✓.

### B. Revocation is the genuinely hard limit — be loud about it
The CEK is **stable across record versions** (foundation decision). **Once a host unseals a CEK, it holds that key in memory/disk forever** — deleting the `_meta/sealed-cek` record does NOT revoke an already-unsealed CEK. This is *inherent* to handing a key to trusted compute (true of any KMS grant). Real revocation has only two mechanisms, neither free:
1. **CEK rotation on revoke** — re-encrypt the record body under a fresh CEK (the host's old CEK no longer decrypts the new ciphertext). This is the *only* true revocation. It's a write (and interacts with history — old versions still under the old CEK). Recommend exposing `vault.rotateRecordCek(collection, id)` as the revocation primitive.
2. **Time-bound sealed CEKs** — encode `expiresAt` in the sealed blob / KMS grant; the host enforces expiry. Bounds exposure without a rewrite, but trusts the host to honor it (acceptable for a trusted-compute host — that's the trust model).

**The honest contract #306 can offer:** *forward* least-privilege (host cryptographically can't reach other records) + *time-bounded* access to the granted record + *rotation* as hard revocation. It cannot offer "un-grant a key the host already saw" without a re-encrypt — and the spec must say so plainly. This matches the `at-hosts.md` trust boundary ("an `at-*` host CAN decrypt the slice it unseals").

### C. Delivery + freshness
The thin `_meta/sealed-cek` envelope is revocable (store delete stops *future* unseals) and supports the expiry/rotation model in B. The host needs a way to discover its sealed-CEK records (poll the `_meta/sealed-cek/<...>/<pid>` prefix, or push). Keep v1 poll-based.

## v1 scope
| Item | In | Note |
|---|---|---|
| `at-aws-kms` (+ GCP/Azure) implement `RecipientSealer` via asymmetric KMS (`alg:'kms-encrypt'`) | ✓ (slice 1, prerequisite) | without it, only `MemoryRecipientSealer` works |
| Grantor `vault.sealRecordToHost(collection,id,hostHint,{expiresAt})` — unwrap raw CEK client-side, seal to host | ✓ | reuses `sealForRecipient`; raw-CEK-only, never the DEK |
| `_meta/sealed-cek/<collection>/<id>/<pid>` thin envelope + host-side unseal+decrypt path | ✓ | mirrors `_meta/sealed-passphrase` |
| In-payload `{collection,id}` binding → host rejects replay against a different record; asymmetric KMS `Decrypt` is CloudTrail-logged (key+principal) | ✓ | encryption context unavailable on asymmetric keys; non-KMS hosts: no cloud trail |
| `vault.revokeSealedRecord(...)` (delete sealed env) + `vault.rotateRecordCek(...)` (true revocation) | ✓ | rotation is the only hard revoke |
| Time-bound `expiresAt` enforced by host | ✓ | bounds the already-unsealed-CEK window |
| Query-scoped (seal all CEKs matching a predicate) | ✗ defer | v1 is single-record; query-scope = loop over matches later |
| Compose with `MagicLinkGrantSpec.record?` (make the advisory field cryptographic) | ◑ | nice unification; can layer after v1 |

## Acceptance (for the build)
- A host with a sealed CEK for `sales/inv-1` decrypts `inv-1` and **fails** to decrypt `sales/inv-2` (no key) — the host-denial test.
- The host never receives a collection DEK (assert the sealed payload is a 32-byte CEK, not a DEK).
- The host rejects a sealed CEK whose embedded `{collection,id}` doesn't match the record it's decrypting (replay-proof); the asymmetric KMS `Decrypt` is CloudTrail-logged (key+principal+time).
- `revokeSealedRecord` stops future unseals; `rotateRecordCek` makes a previously-unsealed CEK stop decrypting the (re-encrypted) record.
- Expired sealed CEK is rejected by the host path.

## Open decisions (for review)
1. **Delivery vehicle** — thin `_meta/sealed-cek` envelope (recommended) vs extending extract-partition transferKey sealing. Thin envelope is lighter + independently revocable.
2. **Revocation default** — document the "rotation is the only hard revoke" limit; make `expiresAt` **required** (force a bounded window) vs optional. Lean **required** for a least-privilege feature.
3. **at-* RecipientSealer alg** — AWS KMS asymmetric `Encrypt` (`kms-encrypt`) for v1; GCP/Azure equivalents as fast-follows. Confirm KMS asymmetric key setup is acceptable for the pilot host.
4. **Scope of slice 1** — ship the `at-aws-kms` RecipientSealer (the recipient-target spec's deferred §12 item) as its own PR first, since #306 is blocked on it.

## Sizing
- Slice 1 — `at-aws-kms` RecipientSealer (asymmetric KMS + `RecipientHint.alg:'kms-encrypt'`): **M** (prerequisite; partly specced in the recipient-target §12).
- Slice 2 — grantor seal API + raw-CEK-unwrap + `_meta/sealed-cek` envelope + host unseal/decrypt path + in-payload `{collection,id}` binding: **M–L**.
- Slice 3 — `revokeSealedRecord` + `rotateRecordCek` (true revocation) + expiry enforcement: **M** (rotation interacts with history).
So #306 ≈ **M + M–L + M**, gated on slice 1 landing first.
