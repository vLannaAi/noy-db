# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in NOYDB, please report it responsibly:

1. **Do NOT open a public issue**
2. Email security concerns to the maintainers via GitHub private vulnerability reporting
3. Include a description of the vulnerability and steps to reproduce

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Security Model

NOYDB is a zero-knowledge storage layer. Backends never see plaintext data.

### Cryptographic Primitives

| Purpose | Algorithm | Parameters |
|---------|-----------|------------|
| Data encryption | AES-256-GCM | 256-bit key, 96-bit random IV per operation |
| Key derivation | PBKDF2-SHA256 | 600,000 iterations, 32-byte random salt |
| Key wrapping | AES-KW (RFC 3394) | 256-bit KEK wraps DEKs |
| Random generation | CSPRNG | `crypto.getRandomValues()` |
| Biometric | WebAuthn / FIDO2 (PRF-capable) | Platform secure enclave — derived key is enclave-bound; non-PRF WebAuthn is a presence/liveness gate, not a confidentiality factor |

All operations use the Web Crypto API (`crypto.subtle`). Zero npm crypto dependencies.

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Lost USB stick | AES-256-GCM — without the secret, all data is ciphertext |
| Cloud admin reads data | Zero-knowledge by default — backends store only ciphertext; non-PRF WebAuthn enrollments are refused by default but can be explicitly opted in via `allowNonPrfInsecure`, producing a documented non-confidential presence gate |
| Brute-force secret | PBKDF2 600K iterations (~200ms/attempt). a 12-char secret is infeasible |
| Tampered record **body** | AES-GCM auth tag — decrypt fails with `TamperedError`. Covers `_data` only; see *Envelope metadata is not authenticated* below. ⚠️ **A `TamperedError` is not by itself proof of an attack** — see *Reading a `TamperedError`* |
| Revoked user retains data | Revocation always re-encrypts the affected collections under new DEKs — the rotation cannot be skipped |
| Compromised biometric store | Wrapped KEK encrypted by WebAuthn credential (PRF-capable); non-PRF enrollments self-decrypt and are not recommended for this threat model |
| Store edits a member's role, permissions, capabilities, or expiry | Since #1096, `_keyring`'s plaintext authority fields carry a `roster_tag` verified on every unlock path — see *The keyring roster is an authenticated surface* below |

### Envelope metadata is not authenticated

The AES-GCM auth tag covers a record's **body** (`_data`). Since #1041 it also
covers the record's **identity** — `{collection, id, _tier, _by}` — and since
#1093 the record's **version** `_v`, all bound in as additional authenticated
data, so a storage backend that rewrites any of them produces an envelope that
no longer authenticates.

> **A remote store — or a `by-peer` peer — cannot alter, relocate, re-author,
> splice or re-version any record it serves. It can still withhold.**

That is narrower than the promise a reader might want, and it is exact. What
follows is what each half means.

### Closed

| A hostile store attempting to… | is refused because |
|---|---|
| **Relocate an envelope** into another collection or record id | identity is bound into the tag; the reader recomputes AAD from the address it fetched from |
| **Expose an elevated record** by lowering `_tier` | a tier-N body relabelled tier 0 is opened with the wrong key |
| **Forge or strip `_by` / `_source`** | both are bound; a tampered field changes the AAD and defeats itself |
| **Splice another record's body** under this record's metadata | the body authenticates at the identity it was sealed for, not the one it is served under |
| **Present a body at a version it was not sealed at** | `_v` is bound (#1093), so a stale copy authenticates *only as itself* and can never be relabelled to outrank the current one |
| **Have a forged envelope committed by sync** | since #1042 the merge verifies **before** `local.put`, so a rejection leaves the local copy untouched |

The vault name is deliberately **not** bound: `adoptPartition` legitimately
re-homes records into a new vault, so cross-vault relocation is a supported
operation rather than purely an attack.

### Still open, and precisely how

**Rollback collapses into withholding — it is no longer forgery.** Binding `_v`
(#1093) removed the half that AAD can reach: a store can no longer restamp an old
body to a higher version, so a stale copy cannot win a convergence comparison and
cannot displace a newer local one. What it *can* still do is serve the genuine
old envelope at its genuine old number while hiding the newer one. That is not an
alteration of any record — every record served is authentic — so no per-envelope
check can see it. It is withholding, below.

**Withholding is not preventable at all.** A store serving nothing, or serving a
genuine older record, cannot be caught by examining the records it does serve.

**Raising `_tier` is withholding, not alteration** — and this is the correction
the adversarial harness produced within minutes of first running, against a
design document that claimed otherwise. The tier-0 read gate treats any envelope
claiming `_tier > 0` as *missing* and returns before decrypting, so AAD never
sees it. Nor can reordering help: a reader holding only the tier-0 key cannot
distinguish a genuine elevation from a forged one, because both fail under the
key it has. The record is hidden, not corrupted.

Both become **detectable** — not prevented — with
[`withVaultHead()`](./docs/subsystems/vault-head.md), which keeps an
authenticated `{id → version}` manifest the store cannot forge and reports
`withheld` and `rolled-back` records on sweep. It is opt-in because it costs a
write per commit and, on a single-device offline vault, defends against nothing.

**A peer with no key for a collection accepts its records unverified.** It cannot
judge what it cannot decrypt. Rejecting instead would break replication of data
a peer legitimately holds but this client is not cleared to read. Such records
are inert here and displace nothing.

**Anti-entropy rests on the client's own store.** A fully cold device with no
local state cannot detect a consistently old world, because the store can present
a coherent past. Closing that needs an external anchor.

Tracking: [#1041](https://github.com/vLannaAi/noy-db/issues/1041) (identity
binding — **done**), [#1042](https://github.com/vLannaAi/noy-db/issues/1042)
(fail closed at merge — **done**),
[#1044](https://github.com/vLannaAi/noy-db/issues/1044) (vault head — **done**),
[#1051](https://github.com/vLannaAi/noy-db/issues/1051) (the refactor that
unblocked the wiring — **done**),
[#1093](https://github.com/vLannaAi/noy-db/issues/1093) (binding `_v` —
**done**). What remains is withholding, which is detected rather than prevented.

### Reading a `TamperedError`

`TamperedError` means *the bytes are not what this client can authenticate*.
Since #1041 that covers more than one situation, so **it is not on its own proof
of an attack**:

| `err.reason` | meaning |
|---|---|
| `'unbound-legacy-format'` | the body opens under an **empty** AAD, so it was sealed before identity binding — a **data-format transition, not tampering**. Records written by `0.6.0-pre.17` or earlier read this way; there is no migration path ([#1100](https://github.com/vLannaAi/noy-db/issues/1100)) |
| absent | no benign explanation was found. Treat as the security alert — a modified, relocated, re-tiered or re-authored envelope, or a store that dropped a bound field such as `_by`/`_tier` while reconstructing one |

The discriminant is **positive evidence, not a guess**: producing a body that
decrypts under the record's key requires that key, which an untrusted store does
not hold. It is also **classification only** — the retry's plaintext is
discarded and the call still throws, so this is not a path by which unbound data
can be accepted.

Note what the legacy verdict concedes: pre-#1041 data carried no authenticated
metadata, so a legacy record that was *also* tampered with reads as legacy. That
is an accurate statement about data that never had a binding, not a weakening of
one.

### The keyring roster is an authenticated surface (#1096)

A `_keyring` file's AUTHORITY half — `role`, `permissions`, `granted_by`,
`expires_at`, `export_capability`, `import_capability` — is stored in
**plaintext** (`_iv: ''`), so admins can edit a member's standing without
holding that member's credential. Since #1096 those fields carry a
`roster_tag`: AES-GCM of the canonical authority tuple (`user_id` included,
so a genuine tag cannot be transplanted onto another member's file) under a
vault-wide **roster key** that rides `deks['_roster']` — the same channel
every other DEK already travels. Verification runs on **every unlock path**
through one chokepoint, `assertRosterAuthenticated` — `loadKeyring`, the
wrap-DEKs password slot, and all three rotate/recover flows — before any
collection read is reachable.

> **A store cannot edit any member's role, permissions, capabilities, or
> expiry.**

#### Closed

| A hostile store attempting to… | is refused because |
|---|---|
| **Promote a role** by editing the plaintext `role` field | the edited file no longer matches its own `roster_tag`; refused at load, before any DEK is handed to the forged role |
| **Grant capabilities** by editing `permissions` | the same tag covers the whole authority tuple, not just `role` |
| **Transplant a genuine tag** from one member's file onto another's | `user_id` is inside the canonical string the tag covers |
| **Delete `roster_tag` or `canary`** and hope for a legacy fallback | both are required; there is no no-canary/no-tag fallback (#1096 removed the last one) |
| **Revoke a peer via a forged admin role** | the forged role is refused at `openVault`, before any grant/revoke call is reachable |
| **Launder a forged file through a legitimate editor** — forge a member's role, then wait for any revoke, `updateUser`, rotation, peer-recovery or secret change to re-sign it | every roster editor **verifies before it restamps**: a flow that reads another member's file checks the existing `roster_tag` before trusting or rewriting any of it. The rotation loop **skips** such a member and reports them in `RotateResult.unverified` (#1114) — skipping is safe there because that loop's effect is to *hand* a member re-wrapped DEKs, so declining gives them less, and the file is neither restamped nor re-wrapped. Every other editor, and the revocation cascade, still refuse outright, because there skipping would give a member *more*. Without this the refusals above would hold only until the next routine admin action — including one the forgery itself provokes, since a forged member is locked out and recovery is the natural remedy |

#### The two honest bounds

**(a) This stops the store, not a malicious member.** Every roster *editor*
must hold the roster key to mint a valid tag (admins edit authority without
holding the target's own credential) — so anyone who legitimately holds the
roster key can forge any authority field for any member. A store colluding
with such a member to serve the forged file is the member-forgery case, not
the store-forgery case this closes, and sits outside this boundary the same
way a store colluding with a revoked member's stale keys already does.

**(b) A replayed genuine roster still verifies.** `roster_tag` authenticates
a file's own contents, not its *recency* — there is no epoch or monotonic
marker. A re-grant that **narrows** standing overwrites the keyring file in
place rather than rotating keys, so the broader pre-narrowing file
legitimately existed; if a store kept a copy, replaying it verifies cleanly
and restores the higher role, including access to collections written
*after* the narrowing (narrowing rotates nothing). That is
[#1097](https://github.com/vLannaAi/noy-db/issues/1097), tracked beside the
anti-entropy/withholding concession above for the same reason: keyring
writes bypass the vault-head observer entirely — they are not records under
`withVaultHead()` — and are versionless by design, so detecting a
stale-but-genuine roster needs a mechanism neither this fix nor the head
provides. Detection would in any case be defeated the same two ways
record-withholding already is: a colluding member simply declining to
verify, and split-view serving to different members.

**Removing a file that cannot be authenticated (#1121).** Refusing a forged
roster creates its own problem: `revoke` decides whether the caller may revoke
a target by reading that target's own `role`, so it cannot act on a file it
will not trust — and a store that forged `"role":"owner"` would make its
victim permanently unremovable, since `revoke` protects owners
unconditionally. `quarantineKeyring()` is the in-band remedy. It is owner-only,
it **refuses a file that verifies** (so it cannot become a way to delete any
keyring while bypassing the normal role checks), and precisely because it acts
only on already-unauthenticatable files it **ignores every claim the file
makes** — including the role. It deletes the file and rotates behind it, with
the rotation scope taken from the *caller's* keyring rather than the target's
unauthenticated DEK map, so a store cannot shrink what a quarantine re-keys.

`verifyRoster()` names which files fail and why, without touching them. Before
it, a bad file announced itself only as an operation failing somewhere else.

**Revocation never rotates the roster key, and that is deliberate.**
`rotateKeys` explicitly refuses `'_roster'` in its `collections` list:
rotating it would mint a fresh key for the caller and then be unable to
re-wrap it for every other member (rotation cannot derive a KEK it was never
given), leaving the whole vault unopenable. A revoked member who already
held the roster key keeps it forever — but that grants them nothing beyond
bound (a): they have no write path to a store that is not already colluding
with them, and a colluding store is the member-forgery case already
conceded above, not a new one.

#### Reading a `KeyringTamperedError`

| `err.details.reason` | meaning |
|---|---|
| `'canary-missing'` | the file has no `canary` at all — refused before the roster check is even reached |
| `'roster-key-missing'` | the caller's DEK set has no `deks['_roster']` — a store that deleted the reserved roster-key entry; absence is treated as an alarm, never as "skip verification" |
| `'roster-tag-missing'` | the file has no `roster_tag` — refused, never treated as an old/legacy file (there is no legacy fallback) |
| `'roster-tag-mismatch'` | the tag does not decrypt to the file's own authority fields — an edited, transplanted, or otherwise inconsistent roster |

As with `TamperedError`, a wrong secret never produces
`KeyringTamperedError` — the KEK epilogue in `loadKeyring` runs first, so an
incorrect password or biometric surfaces as `InvalidKeyError`, and the
roster check only runs once the KEK is already proven correct.

### What NOYDB Does NOT Protect Against

- Malicious application code (app has access to decrypted data in memory)
- Keylogger capturing the secret (OS-level; biometric mitigates this)
- Memory dump attacks (DEKs in process memory during session; mitigated by `db.close()`)
- **A store withholding records, or serving a coherent older world to a cold
  device** — detectable with `withVaultHead()`, not preventable. Relocation,
  re-versioning and metadata forgery ARE refused; see *Envelope metadata is not
  authenticated* above
- A hostile store **suppressing** a revocation's `_keyring` delete. Rotation
  makes the retained keyring's DEKs worthless, which is the protection that
  matters, but the file itself can still be served
- A malicious **member** who already holds the vault-wide roster key forging
  another member's role, permissions, or capabilities — or a store colluding
  with such a member to serve the forged file. `roster_tag` defends against
  the store; it does not defend against a member who already has the key
- A store **replaying** a genuine, pre-narrowing `_keyring` file to restore a
  member's earlier, broader role — detectable only with a mechanism neither
  `roster_tag` nor `withVaultHead()` provides yet ([#1097](https://github.com/vLannaAi/noy-db/issues/1097))

### Recommendations

1. Use secrets of 12+ characters or 4+ word diceware
2. Enroll biometric for daily use to reduce secret exposure
3. Store the secret in a password manager — loss means permanent data loss
4. Prefer a store you control for the **primary** target. The confidentiality
   guarantee holds against any backend, but ordering integrity currently does
   not — see *Envelope metadata is not authenticated*
