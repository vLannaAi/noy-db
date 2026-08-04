# #963 small hardening: presence identity leak + on-pin comment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close two smaller findings from external security review #963: (1) the presence storage-poll fallback leaks `userId` in cleartext to the storage adapter, contradicting the module's own no-identity-leak promise; (2) the on-pin brute-force cost comment overstates the attacker cost by ~4 orders of magnitude.

**Architecture:** Presence already has TWO write paths. The pub/sub path (`update`, presence.ts:100) encrypts `{userId, lastSeen, payload}` so the adapter learns nothing. The storage-poll fallback (`writeStorageRecord`, presence.ts:235) does NOT — it writes `userId` as (a) the record id, (b) a cleartext `StoragePresenceRecord.userId` field, and surfaces peer identity from that cleartext field on read. Bring the storage path up to the pub/sub path's guarantee: move `userId` inside the encrypted `data`, and use a deterministic adapter-opaque **blind-index tag** (keyed by the presence key) as the record id so the adapter cannot map records to users while per-user updates still overwrite.

**Tech Stack:** TS ESM, `crypto.subtle` only (no npm crypto — hub portability rule), vitest, pnpm. Packages: `@noy-db/hub` (presence), `@noy-db/on-pin` (comment only).

## Global Constraints
- Branch `fix/963-small-hardening` (off main, already checked out). **NEVER add Claude/AI attribution** to commits/changesets/docs. Grep the diff before commit for any private-client name.
- **Hub portability:** presence.ts runs in browser/Worker/Deno/Bun — `crypto.subtle` only, no Node built-ins. Do NOT import a crypto npm package.
- **Do NOT touch `collection.ts`, `vault.ts`, or `noydb.ts`** — they are at their kernel-surface line ceilings. `presence.ts` (in `with-sync/`) is NOT ceiling-guarded — editing it is fine.
- Gates: `pnpm --filter @noy-db/hub test` (presence tests) + `pnpm --filter @noy-db/on-pin test` + `pnpm --filter @noy-db/hub typecheck` + `pnpm --filter @noy-db/hub build` + `pnpm lint`. All green.

## Verified source facts (from recon)
- `packages/hub/src/with-sync/presence.ts`:
  - Module doc lines 5-8 promise "The adapter never learns user identities from presence payloads." The storage-poll path violates this.
  - `PresenceHandleOpts.userId` doc (:31) currently says "embedded unencrypted in storage records" — this becomes false after the fix; update it.
  - `StoragePresenceRecord` (:47-52) = `{ userId, lastSeen, iv, data }`. `data` holds ONLY `JSON.stringify(payload)` (:237), not userId.
  - `writeStorageRecord` (:235-273): encrypts only `payload`; builds record with cleartext `userId` (:250); `put(vault, storageCollection, this.userId, envelope)` — record id IS `this.userId` (:267).
  - `pollStoragePresence` (:275-309): self-skip `if (id === this.userId)` (:285); stale pre-filter `record.lastSeen < cutoff` (:290); peer identity `peers.push({ userId: record.userId, ... })` sourced from CLEARTEXT (:300).
  - Available helper: `hmacSha256Hex(key: CryptoKey, data: Uint8Array): Promise<string>` (kernel/enclave/crypto.ts:446) — but it needs an HMAC `sign` key. The blind-index pattern `deriveClassifyIndexKey` (kernel/enclave/classify/bidx.ts:68) shows how to HKDF a `sign`-only HMAC key from a DEK. `derivePresenceKey(dek, collectionName)` (crypto.ts:548) already gives the presence AES key; `getPresenceKey()` (presence.ts) resolves it.
- `packages/on-pin/src/index.ts:44-48`: claims a 4-digit PIN's 10,000-space at 100k PBKDF2 iters ≈ 10^9 hash ops ≈ "roughly hours" for a GPU. Wrong: 10,000 candidates is exhausted in **seconds** on a GPU once the state blob leaks — the PBKDF2 cost does not save a 4-digit space. That is exactly WHY on-pin is UX-convenience-only, never primary auth.

---

### Task 1: presence storage-poll no longer leaks userId + tests

**Files:** `packages/hub/src/with-sync/presence.ts`. Tests: `packages/hub/src/with-sync/presence.test.ts` (if it exists; else create it — check first with a glob for existing presence tests).

**Behavior (encrypted mode — `this.encrypted && key`):**
- Add a private method to derive a deterministic **presence tag key** from the collection DEK, mirroring `deriveClassifyIndexKey`: HKDF-SHA256 from the raw DEK with a presence-specific domain string (e.g. `'noydb.presence.tag.v1'`) → a non-extractable `HMAC`/`SHA-256` `sign`-only key. (Get the DEK the same way `getPresenceKey` does — via `this.getDEK(this.collectionName)`.) Cache it beside `presenceKey`.
- Add `private async presenceTag(userId: string): Promise<string>` = `hmacSha256Hex(tagKey, utf8(userId))`.
- `writeStorageRecord`: encrypt `JSON.stringify({ userId: this.userId, payload })` into `data` (userId now INSIDE ciphertext, like the pub/sub path). Remove the cleartext `userId` field from the written record. Use `record id = await this.presenceTag(this.userId)` for the `put`, NOT `this.userId`. Keep `lastSeen` cleartext in the record (it is a timestamp, not an identity — the module promise is about identities — and the stale pre-filter needs it without decrypting).
- `StoragePresenceRecord`: drop the `userId` field → `{ lastSeen, iv, data }`.
- `pollStoragePresence`: self-skip must compare against MY tag, not raw userId — compute `const myTag = await this.presenceTag(this.userId)` once and `if (id === myTag) continue`. After decrypting `data`, parse `{ userId, payload }` and surface `peers.push({ userId, payload, lastSeen: record.lastSeen })` from the DECRYPTED userId. Keep the stale pre-filter on cleartext `record.lastSeen`.
- **Unencrypted mode (`!this.encrypted`)**: no key exists, so no tag/encryption is possible — keep the current cleartext behavior (record id = userId, cleartext payload). This path is only reached when the whole vault is unencrypted (a dev/test posture); document that presence identity privacy requires encryption. (Do NOT invent a keyless tag — there is no key.)
- Update the doc comments: `PresenceHandleOpts.userId` (:31) — remove "embedded unencrypted in storage records"; state userId is encrypted inside the storage record (encrypted mode) and the record id is an adapter-opaque tag. The `StoragePresenceRecord` doc (:43-46) — update the shape and note userId now rides inside `data`.

- [ ] **Step 1: failing tests** — find or create presence tests. Cover (encrypted vault):
  - `update()` via storage-poll: after a write, inspect the raw stored envelope/record on the adapter and assert the record id is NOT the userId, no top-level `userId` field is present, and the plaintext userId string does not appear anywhere in the serialized record (`JSON.stringify(record)` must not contain the userId).
  - round-trip: two handles (userA, userB) sharing a store, storage-poll mode (no pubsub adapter); after both `update()`, each `subscribe` callback surfaces the OTHER peer with the correct decrypted `userId` and payload, and excludes self. (Proves identity still works via decryption + tag self-skip.)
  - determinism: two successive `update()`s by the same user write to the SAME record id (overwrite, not accumulate) — assert `list()` length stays 1 per user.
  - unencrypted vault: behavior unchanged (record id = userId) — a guard test so we don't accidentally break the plaintext dev path.
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** the tag key derivation + rewritten write/poll paths + doc updates.
- [ ] **Step 4: green** + `pnpm --filter @noy-db/hub typecheck`.
- [ ] **Step 5: commit** — `fix(hub): presence storage-poll no longer leaks userId to the adapter (#963)`

---

### Task 2: pub/sub IV fix (#968) + on-pin comment + changesets + gates

**Files:** `packages/hub/src/with-sync/presence.ts` (`update()` pub/sub branch, ~:127-134); `packages/hub/__tests__/presence.test.ts` (add a pub/sub round-trip test); `packages/on-pin/src/index.ts:44-48`; `.changeset/presence-userid-leak.md`; `.changeset/presence-pubsub-iv.md`; `.changeset/on-pin-cost-comment.md`.

**pub/sub IV bug (#968), verified real:** `encrypt(plaintext, key)` (kernel/enclave/crypto.ts:322) generates and RETURNS its own IV as `result.iv`. The `update()` pub/sub branch instead builds a separate `const iv = generateIV(); const ivB64 = bufferToBase64(iv)` and stores `ivB64` while discarding `encrypt()`'s real IV — so a subscriber decrypting with the stored IV hits an AES-GCM auth failure. Encrypted pub/sub presence is broken; latent because no test does an encrypted publish→subscribe→decrypt round-trip.

- [ ] **Step 1: failing pub/sub round-trip test** — in `presence.test.ts`, add a test using a stub pub/sub adapter (implements `presencePublish`/`presenceSubscribe` — mirror the existing storage-poll fixtures but wire the pub/sub seam; check how `getPubSubAdapter`/`presenceSubscribe` are consumed in `subscribe()`): userA `update()`s over an ENCRYPTED handle; a subscribed userB receives and DECRYPTS the broadcast, surfacing userA's correct `userId` + payload. This fails today (wrong IV → decrypt throws / peer missing). Run red.
- [ ] **Step 2: fix** — replace the pub/sub branch body with `const { iv, data } = await encrypt(plaintext, key); encryptedPayload = JSON.stringify({ iv, data })`; remove the now-unused `generateIV()`/`ivB64` lines. If `generateIV`/`bufferToBase64` become unused imports after this, remove them from the import (check `writeStorageRecord` still uses them — it does use `generateIV`/`bufferToBase64` for the storage path, so they stay imported). Green.
- [ ] **Step 3: on-pin comment** — replace the "~10^9 hash ops — roughly hours" bullet with an accurate statement: a 4-digit PIN's 10,000-candidate space is exhausted in **seconds** on a GPU once an attacker holds the state blob — PBKDF2 iteration cost does not meaningfully protect a space that small. This is precisely why on-pin is a UX-convenience resume factor, NOT primary authentication, and why the state blob must never be persisted to a public location. Keep the surrounding bullets intact; surgical edit only.
- [ ] **Step 4: changesets** —
  - `.changeset/presence-userid-leak.md` (`'@noy-db/hub': patch` — security fix, back-compatible record shape change within the reserved `_presence_*` collection; note old cleartext-id presence records are simply superseded on next update): presence storage-poll fallback no longer writes `userId` in cleartext to the storage adapter — userId is encrypted inside the record and the record id is an adapter-opaque per-user tag, matching the pub/sub path's guarantee and the module's stated no-identity-leak property.
  - `.changeset/presence-pubsub-iv.md` (`'@noy-db/hub': patch` — correctness fix, #968): the presence pub/sub broadcast path stored a discarded IV instead of the one `encrypt()` used, so encrypted pub/sub presence could never decrypt; it now stores the correct IV.
  - `.changeset/on-pin-cost-comment.md` (`'@noy-db/on-pin': patch` — doc-only): correct the overstated PIN brute-force cost comment (seconds, not hours).
- [ ] **Step 5: gates** — `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub test` + `pnpm --filter @noy-db/on-pin test` + `pnpm lint`. All green.
- [ ] **Step 6: commit** — `fix(hub): presence pub/sub stores the correct IV (#968); docs(on-pin): correct PIN brute-force cost (#963)`

## Out of scope
- WebAuthn finding 1 (separate PR #967). in-rest finding 2 (separate re-architecture PR).
- Any change to the pub/sub presence path (already correct) or to presence key rotation.
