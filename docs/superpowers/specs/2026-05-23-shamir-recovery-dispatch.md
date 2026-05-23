# Shamir recovery profile dispatch (#196, slice 1)

> Per-issue spec for the **Shamir slice** of #196 ("recovery-profile
> dispatch — shamir, multi-channel, admin-mediated"). Unblocks #195's
> mandatory-strong-recovery rule by making at least one strong profile
> end-to-end implementable. Multi-channel and admin-mediated are
> tracked but out of scope here.

## 0. Status

- Date: 2026-05-23
- Tracks: #196 (slice 1 — Shamir only)
- Out of scope: multi-channel profile, admin-mediated profile
  (subsequent slices of #196), #195's policy enforcement (depends
  on this slice).
- Builds on: `@noy-db/on-shamir` primitives (shipped), the existing
  paper-recovery pattern in `packages/hub/src/team/recovery.ts` +
  `packages/hub/src/team/rotate-recover.ts`.
- Architectural backdrop: foundation doc §4 (recovery dimension),
  §11.10 (never-non-recoverable invariant), §13.5 (composes with
  client-portability via recovery enrollment shape).

## 1. Goal

Make the `shamir` recovery profile end-to-end functional through
three API verbs that mirror the paper profile:

1. `db.enrollRecovery({ profile: 'shamir', k, n })` — mints a fresh
   recovery secret, splits it into N Shamir shares, wraps the user's
   DEKs under the recovery secret, persists the entry, returns the
   share strings (one-time disclosure).
2. `db.recoverPassphrase({ profile: 'shamir', shares })` — combines
   K of the shares, decrypts the DEK set, derives a fresh KEK from
   the new passphrase, rewraps.
3. `db.rotateRecovery({ profile: 'shamir', k, n })` — symmetric to
   paper-rotate: replaces the existing Shamir entry with a fresh one,
   returns new shares.

After this slice: `RecoveryProfileNotImplementedError` no longer
fires for `profile: 'shamir'`. Multi-channel and admin-mediated
continue to throw with their existing pointer.

## 2. Architectural framing

### 2.1 The non-extractable-KEK constraint

Hub's KEK is derived from passphrase via PBKDF2 with `extractable:
false` (`packages/hub/src/crypto.ts:72`). on-shamir's `splitKEK`
requires an extractable KEK and so cannot directly split the live
KEK.

**Resolution**: don't split the live KEK. Mint a **fresh recovery
secret** (32 random bytes) at enrollment time, use it to wrap the
DEK set (parallel to how paper-recovery wraps DEKs under a
code-derived key), and Shamir-split the 32 random bytes using
on-shamir's lower-level `splitSecret`. The fresh recovery secret is
ephemeral — discarded after enrollment. The shares are the only path
back to it.

This mirrors paper-recovery's pattern exactly: paper wraps DEKs
under a code-derived AES-GCM key, then forgets the key (the code is
the only way back). Shamir wraps DEKs under a recovery-secret AES-GCM
key, then forgets the key (the K shares are the only way back).

### 2.2 Why NOT use `splitKEK` / `combineKEK`

The on-shamir README's high-level API operates on `CryptoKey`. For
hub, we want:

- The **wrap-and-split** ceremony to be atomic with no extractable
  KEK floating in memory longer than necessary.
- The recovery secret to be a 32-byte buffer we control directly,
  not a `CryptoKey` we have to extract.
- Symmetric semantics with the existing `WrappedDeksBlob` primitive
  used by paper-recovery (#44).

`splitSecret` (raw bytes → shares) and `combineSecret` (shares →
raw bytes) operate at the right layer. Wrapping happens via the
shared `mintWrappedDeksBlob` / `unwrapDeksFromBlob` primitives.

## 3. Storage layout

### 3.1 `_meta/recovery-shamir` document

```ts
interface ShamirRecoveryDoc {
  readonly _noydb_recovery: 1
  readonly profile: 'shamir'
  readonly entries: ReadonlyArray<ShamirRecoveryEntry>
}

interface ShamirRecoveryEntry extends WrappedDeksBlob {
  /** Stable id for this entry. Allows multiple Shamir splits to coexist. */
  readonly entryId: string
  /** Threshold (k) — minimum shares to reconstruct. */
  readonly k: number
  /** Total shares (n) minted at enrollment. Informational. */
  readonly n: number
  /** x-coordinates of the n minted shares. Informational; lets admins
   *  match shares-in-the-wild to a specific enrollment. */
  readonly xCoords: ReadonlyArray<number>
  /** ISO timestamp. */
  readonly enrolledAt: string
  /** Optional caller-supplied label (e.g., "2-of-3 board escrow"). */
  readonly label?: string
}
```

`WrappedDeksBlob` (existing, from `team/wrapped-deks.ts`) carries
`{ salt, iv, wrappedDeks }` — same shape used by paper. The fields
specific to Shamir are `k`, `n`, `xCoords`, `entryId`, `label`.

### 3.2 Multiple entries allowed

Unlike paper which has a flat list of code-entries (each
single-use), Shamir entries are **persistent** (shares aren't
consumed at recovery — they can be reused). Multiple entries can
coexist:

- 2-of-3 board escrow (entryId: `'board-escrow'`)
- 3-of-5 personal split across devices (entryId: `'personal'`)
- 2-of-2 with spouse (entryId: `'spouse'`)

The `recoverPassphrase` caller supplies an optional `entryId` to
disambiguate; if omitted, hub tries each entry in turn (first one
that combines successfully wins).

### 3.3 Not destructive on recovery

Paper burns an entry on use (single-use codes). Shamir does NOT —
shares can be reused indefinitely until the user rotates the
recovery via `rotateRecovery`. This is a deliberate threat-model
choice: Shamir shares are typically physical (paper in safe, USB
stick with trusted party); recovery is rare; reuse is fine.

`rotateRecovery` is the explicit "I want to refresh the splits"
ceremony. Recovery alone does not invalidate the shares.

## 4. API surface — Hub additions

### 4.1 `RecoveryProof` type extension

`packages/hub/src/team/rotate-recover.ts`:

```ts
export type RecoveryProof =
  | { readonly profile: 'paper'; readonly payload: { readonly code: string } }
  | { readonly profile: 'shamir'; readonly payload: {
      /** Optional disambiguator when multiple Shamir entries are enrolled.
       *  When omitted, hub tries each enrolled entry in turn. */
      readonly entryId?: string
      /** K or more share strings (base32-encoded per on-shamir). */
      readonly shares: ReadonlyArray<string>
    } }
```

### 4.2 `enrollRecovery` extension

`packages/hub/src/noydb.ts`:

```ts
async enrollRecovery(
  vault: string,
  enrollment:
    | { profile: 'paper'; entries: ReadonlyArray<PaperRecoveryEntry> }
    | { profile: 'shamir'; k: number; n: number; label?: string; entryId?: string },
): Promise<EnrollRecoveryResult>

interface EnrollRecoveryResult {
  /** Present when profile === 'shamir' — the N share strings.
   *  Show once to the caller; CANNOT be retrieved again. */
  readonly shares?: ReadonlyArray<string>
  /** Stable entry identifier — surfaces in audit logs and `recoverPassphrase` payload. */
  readonly entryId: string
}
```

Behavior for `profile: 'shamir'`:

1. Load the caller's keyring (must be the requesting user — same
   permission shape as `db.getKeyring`).
2. Validate `k`, `n` (2 ≤ k ≤ n ≤ 255, per on-shamir's bounds).
3. Generate 32 random bytes — the **recovery secret**.
4. Mint a `WrappedDeksBlob` wrapping the DEK set under the recovery
   secret (use `mintWrappedDeksBlob(deks, recoverySecret)` —
   passing bytes directly via a new overload, or wrap the bytes as
   a base64 "code" string compatible with the existing API).
5. Split the recovery secret via `splitSecret(secret, k, n)`.
6. Encode each share via `encodeShareBase32` from on-shamir.
7. Persist a new `ShamirRecoveryEntry` to `_meta/recovery-shamir`.
8. Zero the recovery secret + shares from local buffers.
9. Return `{ shares: shareStrings, entryId }`.

### 4.3 `recoverPassphrase` Shamir branch

`packages/hub/src/team/rotate-recover.ts`:

Add `recoverViaShamir(...)` mirroring `recoverViaPaperCode(...)`:

1. Decode each supplied share string via `decodeShareBase32`.
2. Load `_meta/recovery-shamir` entries.
3. If `payload.entryId` is supplied, pick that entry; else iterate.
4. For each candidate entry:
   - Reject if `shares.length < entry.k`.
   - Combine shares via `combineSecret` → recovery secret bytes.
   - Try `unwrapDeksFromBlob(entry, recoverySecretBase64)` →
     succeeds means we found the matching entry.
   - On failure, try the next entry.
5. If no entry matches: throw `InvalidKeyError` with message about
   share mismatch / no matching enrollment.
6. With unwrapped DEKs: mint fresh KEK from `newPassphrase` + fresh
   salt, rewrap DEKs, write keyring (same path paper uses).
7. Recovery entry is **preserved** (Shamir is reusable, see §3.3).
8. Zero recovery secret from local buffers.

### 4.4 `rotateRecovery` Shamir branch

`packages/hub/src/noydb.ts`:

```ts
async rotateRecovery(
  vault: string,
  options:
    | { profile: 'paper'; count?: number; codeGenerator?: () => string }
    | { profile: 'shamir'; k: number; n: number; label?: string; entryId?: string },
  factors?: FactorProofBundle,
): Promise<RotateRecoveryResult>

interface RotateRecoveryResult {
  /** New paper codes (when profile === 'paper') OR new Shamir shares (when 'shamir'). */
  readonly newCodes?: readonly string[]
  readonly newShares?: readonly string[]
  readonly entryId?: string
}
```

Behavior for `profile: 'shamir'`:

1. Same policy gate (`rotate-recovery`) as paper rotation.
2. Validate there's an existing Shamir entry (matched by `entryId`
   if provided, else exactly one entry must exist; otherwise reject
   with a clear "ambiguous — supply entryId" error).
3. Run the §4.2 enrollment ceremony with the new `k`, `n`, `label`.
4. Replace the old entry in `_meta/recovery-shamir` (atomic
   single-doc write).
5. Return `{ newShares, entryId }`.

## 5. Recovery-secret encoding consideration

`mintWrappedDeksBlob(deks, code)` accepts a string "code" today and
derives a key via PBKDF2. For Shamir we have raw bytes, not a
password. Two options:

**A. Reuse `mintWrappedDeksBlob` as-is**: base64-encode the 32
recovery secret bytes and pass as a string. PBKDF2 still applies
internally. Pro: zero changes to the shared primitive. Con: PBKDF2
over 32 random bytes is wasted work — entropy is already maximal.

**B. Add a `mintWrappedDeksBlobFromBytes` overload**: takes raw
key bytes, skips PBKDF2, uses AES-GCM directly. Pro: cleaner
crypto. Con: new shared primitive to maintain; subtle differences
between paper and Shamir code paths.

**Decision: A** (reuse). PBKDF2 over high-entropy input is harmless
(it's essentially a deterministic hash); the wasted CPU is once per
recover/enroll, not on every operation. Slight engineering simplicity
wins. Document in code comments.

## 6. Tests

Following the existing test files' shape:

### 6.1 New: `packages/hub/__tests__/shamir-recovery.test.ts`

Cases:

- **Enroll 2-of-3, recover with shares 1+2**: round-trip succeeds,
  vault opens under the new passphrase.
- **Enroll 2-of-3, recover with shares 1+3**: succeeds (any K of N).
- **Enroll 2-of-3, recover with only 1 share**: fails with clear
  "below threshold" error.
- **Enroll 2-of-3, recover with all 3 shares**: succeeds (above
  threshold is fine).
- **Enroll TWO 2-of-3 splits, recover with entryId disambiguator**:
  succeeds against the named entry.
- **Enroll TWO splits, recover WITHOUT entryId**: succeeds against
  whichever combines (iterate-and-try).
- **Mismatched shares (from different enrollments)**: combineSecret
  yields garbage → unwrap fails → next entry attempted → if none
  match, throw clear error.
- **Tampered shares (single-byte flip in base32)**: decode fails or
  combine yields garbage → reject.
- **Validation**: `k < 2`, `k > n`, `n > 255`, `n < 2` all rejected
  with clear messages.
- **`rotateRecovery({ profile: 'shamir', k, n })`**: rotates an
  existing entry; old shares no longer combine to a working secret;
  new shares do.
- **`rotateRecovery` with ambiguous entry list (no entryId, 2 entries)**:
  rejected with clear "supply entryId" error.
- **`enrollRecovery` does not leak the recovery secret in any persisted
  field**: introspect `_meta/recovery-shamir` doc; assert no field
  contains the raw secret bytes or any field of length 32 base64-ish
  beyond the standard salt/iv positions.

### 6.2 Update: existing `recoveryProfileNotImplemented`-style tests

If any test asserts `'shamir'` throws `RecoveryProfileNotImplementedError`,
flip to assert successful round-trip OR delete (the new positive
tests subsume).

Grep candidates: `packages/hub/__tests__/rotate-recover.test.ts`,
`pr1a-public-recovery.test.ts`, `pr4-auto-rotate-recovery-codes.test.ts`,
`rotate-recovery.test.ts`.

## 7. Out of scope

- **Multi-channel profile dispatch** — separate slice.
- **Admin-mediated profile dispatch** — separate slice.
- **#195 managed-mode mandatory-recovery enforcement** — unblocked
  by this slice but implemented separately.
- **Share storage UI** — the caller decides how to surface, persist,
  or distribute the shares. The hub returns strings; downstream is
  caller responsibility.
- **Share format migration** — uses on-shamir's existing
  `encodeShareBase32` / `decodeShareBase32`. Format stability is
  on-shamir's responsibility.
- **Tracking comments** — `RecoveryProfileNotImplementedError`
  references `#10` in throw sites. After this slice, update those to
  `#196` (since #10 is closed; #196 is the actionable tracker for
  the remaining two profiles).

## 8. PR boundary

One PR containing:

- `packages/hub/src/team/recovery.ts` — add `ShamirRecoveryEntry`
  type, `loadShamirRecoveryEntries`, `saveShamirRecoveryEntries`,
  `mintShamirRecoveryEntry`, `unwrapDeksFromShamirEntry` (mirrors
  paper).
- `packages/hub/src/team/rotate-recover.ts` — extend `RecoveryProof`
  union with `'shamir'`, add `recoverViaShamir`, route from
  `recoverPassphrase`.
- `packages/hub/src/noydb.ts` — extend `enrollRecovery` and
  `rotateRecovery` discriminated unions, route to Shamir handlers.
- `packages/hub/src/policy/errors.ts` — update
  `RecoveryProfileNotImplementedError` callers to drop `'shamir'`
  from the unimplemented list (only `multi-channel` and
  `admin-mediated` remain).
- `packages/hub/__tests__/shamir-recovery.test.ts` — new test file
  per §6.1.
- `packages/hub/src/index.ts` — export new types/functions if any
  are public.
- ROADMAP.md — add an entry under "Recently shipped" once the PR
  merges (not part of the diff per release workflow).

Approximate diff: ~400–600 LOC additions, ~50 LOC modifications,
1 new test file.

## 9. Acceptance

- [ ] `db.enrollRecovery({ profile: 'shamir', k: 2, n: 3 })` returns
      `{ shares: [3 strings], entryId }` and persists `_meta/recovery-shamir`.
- [ ] `db.recoverPassphrase({ profile: 'shamir', shares: [2-of-3] })`
      succeeds; vault opens under new passphrase.
- [ ] Threshold not met (`shares.length < k`) → clear error.
- [ ] Mismatched/tampered shares → clear error.
- [ ] Multiple Shamir entries coexist; `entryId` disambiguates.
- [ ] `db.rotateRecovery({ profile: 'shamir', k, n })` replaces the
      entry; old shares no longer unlock; new shares do.
- [ ] `RecoveryProfileNotImplementedError` no longer thrown for
      `'shamir'`; multi-channel / admin-mediated still throw with
      `#196` reference.
- [ ] Full hub test suite passes (1680+ tests + new Shamir suite).
- [ ] Typecheck + lint clean.

## 10. Open questions

- **Q.1** Should we tighten the `enrollRecovery` discriminated union
  to make `shares` mandatory in the result for Shamir (vs optional)?
  Recommendation: yes — at the type level, `{ profile: 'paper' }`
  enrollments return `{ entryId }` only; `{ profile: 'shamir' }`
  return `{ entryId, shares }`. Discriminated result type. Easier
  for callers to consume.
- **Q.2** Should the `RecoveryProof` payload disambiguate by `entryId`
  or by `xCoords` of the supplied shares? Recommendation: `entryId`
  is simpler and matches the on-disk identifier; xCoords are an
  implementation detail of the share material. Skip xCoord-based
  dispatch unless the entryId-based path proves insufficient.
- **Q.3** Should `rotateRecovery({ profile: 'shamir' })` require a
  recovery proof (i.e., user must demonstrate they hold K current
  shares) to perform the rotation? Recommendation: NO — rotation is
  a routine maintenance ceremony performed while the vault is
  unlocked via passphrase; requiring K shares would be paradoxical
  ("you can't refresh recovery unless you have current recovery").
  The existing `rotate-recovery` policy gate (passphrase + optional
  factors) is sufficient.

---

Cross-references:

- Foundation: `2026-05-23-sealing-at-dimension-foundation.md` §4, §11.10
- Issues: #196 (this slice), #195 (downstream consumer), #10 (closed predecessor)
- Primitives: `@noy-db/on-shamir/splitSecret`, `@noy-db/on-shamir/combineSecret`,
  `@noy-db/on-shamir/encodeShareBase32`, `@noy-db/on-shamir/decodeShareBase32`
- Shared crypto: `packages/hub/src/team/wrapped-deks.ts`
- Mirror surface: `packages/hub/src/team/recovery.ts` (paper persistence),
  `packages/hub/src/team/rotate-recover.ts` (paper dispatch)
