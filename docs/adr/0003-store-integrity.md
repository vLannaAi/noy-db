# ADR 0003: Store integrity — untrusted for ordering, not just confidentiality

> **Status:** proposed (#1071 — the design gate on #1041, #1042, #1044).
> **Date:** 2026-08-14. MADR-lite, per ADR 0001.

## Context

`@noy-db/hub` claims the storage backend is untrusted. That claim is currently true for
**confidentiality** and false for **integrity of ordering and placement**, and `SECURITY.md`
has to concede it in one sentence:

> A remote store — or a `by-peer` peer — is trusted for the integrity of version ordering and
> envelope placement, while being untrusted for confidentiality.

**The purpose of this work is to delete that sentence honestly.** Not to narrow it.

The AES-GCM auth tag covers the record body (`_data`). The sibling fields — `_v`, `_ts`, `_by`,
`_source`, `_tier`, `_noydb` — sit outside the AEAD and carry no integrity, so a store can
rewrite them and the tag still verifies. Reproduced: re-serving an old envelope with an inflated
`_v` overwrites the client's newer data, `pull()` reports zero errors, no exception is raised.

### Why one scheme, not three staged fixes

Decided at the family root on 2026-08-12 and not reopened here. Two reasons, the second being
the real one:

1. **Staging risks a second format break.** #1041 must choose what to bind; #1044 needs a stable
   notion of record identity and a per-record digest to anchor on. Freeze the tuple before the
   anchor's requirements are known and it may bind the wrong thing — so staging is more expensive
   *even measured purely in migration cost*, which was the whole argument for staging.
2. **It is the premise, not hardening.** A store untrusted for confidentiality but trusted for
   ordering is a hole in the product's central claim.

### The three constraints (verified in source; do not re-derive)

**(a) `advancePastRemote` rewrites `_v` on existing ciphertext with no DEK.**
`with-sync/engine.ts:937` returns `{ ...winner, _v: remote._v + 1 }` — same `_iv`, same `_data`.
The comment above it states the dependency outright: *"`_v` is envelope metadata — AEAD-unbound
… so the engine may restamp ciphertext."* Every prior analysis hit this and worked around it.

`:974` (`reassertTombstone`) does the same, but only to tombstones — empty `_data`.

**These are the only two.** Period-freeze/archival (`with-audit/periods/vault-facade.ts`) and
`_tier` elevation (`with-audit/tiers/index.ts`) also rewrite envelopes in bulk, but both
**re-encrypt with a DEK in hand**, so they can supply AAD without redesign.

**(b) `with-sync` is DEK-free by design and `check:architecture` guards it.** The engine's only
enclave import is shape predicates (`engine.ts:29`). This is why AAD alone cannot prevent
anything at merge time: AAD is verified inside `subtle.decrypt`, and `applyRemote`
(`engine.ts:939-948`) never decrypts — it commits the envelope first and fails at read time,
after the client's newer copy is gone.

**(c) The vault name must stay unbound.** `adoptPartition`
(`with-cargo/adopt-partition.ts:140`) re-homes a whole partition into a new vault name with a
bare `saveAll` and no re-encryption. Cross-vault relocation is a **supported product feature**,
not an attack, and AAD cannot distinguish intent. Binding it broke 288 tests. Do not "fix" this.

## Decision 1 — a merge authority, injected at construction

(a) and (b) are one problem: the engine restamps `_v` without a DEK **because the engine has no
DEK**, and #1042's job is to give the merge a DEK-holding capability. One seam resolves both.

Define in `src/port/with/` (type-only, no `with-*` import — the layering precedent set by the
existing port modules):

```ts
export interface MergeAuthority {
  /** Does this envelope authenticate at the identity and version it claims? */
  verify(collection: string, id: string, env: EncryptedEnvelope): Promise<boolean>
  /** Re-stamp to `toVersion`, re-sealing under the same DEK. Replaces the spread. */
  advance(collection: string, id: string, env: EncryptedEnvelope, toVersion: number): Promise<EncryptedEnvelope>
}
```

`SyncEngine` takes one at construction. The closure holds the DEK; the engine's import graph is
unchanged, so `check:architecture` passes **unweakened** — no allowlist entry, no guard edit. If
the guard needs relaxing, the design is wrong.

`applyRemote` calls `verify()` **before** `local.put`, and rejects into `PullResult.errors`
rather than throwing — a hostile store must not be able to halt a sync by poisoning one record.

`advancePastRemote` becomes a call to `advance()`. `reassertTombstone` (`:974`) operates on
empty bodies; it needs a *decision* (bind tombstones or exempt them explicitly) rather than a
mechanism — see Open Questions.

## Decision 2 — bind `{collection, id, _v, _tier, _by}`; never `vault`

Decision 1 is what makes `_v` bindable, and binding `_v` is what turns detection into
prevention. With it:

| Attack | Outcome |
|---|---|
| re-serve an old body with inflated `_v` | AAD for `v99` ≠ body sealed at `v1` → **rejected before `local.put`** |
| relocate into another collection/id | rejected |
| flip `_tier` to hide a record | rejected |
| forge `_by` / `_source` | rejected |

Note this holds for a **fresh device with no prior state** — the client recomputes AAD from the
envelope's own claimed metadata, so it needs no local copy to compare against. Bootstrap, which
earlier analyses listed as uncovered, is covered.

`_ts` is deliberately excluded: it is advisory, and binding it would make legitimate clock
correction a tamper event.

## Decision 3 — the head detects **omission**, not alteration

This is the consequence that shrinks #1044 considerably, and it follows from Decision 2.

Once every envelope is self-authenticating at its identity and version, the only remaining
attacks are ones of **absence**:

- **withholding** — serving a genuine, unmodified `v1` when `v7` exists
- **deletion suppression** — never serving a record at all

Neither is per-envelope detectable, by construction: an authentic old envelope is
indistinguishable from an authentic current one without external knowledge of what *should* be
there.

So the head is an **authenticated manifest of `{id → version}`** for the vault, plus its own
authentication — not a Merkle chain over content. It does not need to carry digests, because
content integrity is already handled. That is a materially smaller subsystem than "signed vault
head" implied when it was filed, and it is the direct payoff of settling the anchor's
requirements before freezing the tuple.

**The head is an opt-in `with-*` service; AAD + merge verify are kernel.**

Rationale: AAD and verify have near-zero coordination cost and close *alteration* — they should
never be optional, because they are the premise. The head costs a write per commit and needs
anti-entropy; for a single-device offline vault it defends against nothing. Making it kernel
would tax every user for a multi-writer property.

This split is what lets `SECURITY.md` replace the concession with something precise and true:

> A remote store — or a `by-peer` peer — **cannot alter, relocate, re-tier, re-author or rewind
> any record it serves.** Without `withVaultHead()`, it can still **withhold** or **omit**:
> serve an authentic but stale record, or none at all. It never sees plaintext.

That sentence is honest, narrower, and it is a *statement of what the design guarantees* rather
than an admission of what it does not.

## Decision 4 — the stable is `0.7.0`

`0.6.0-pre.16` has shipped a format the stable will not use. Calling the stable `0.6.0` would
mean `0.6.0` and `0.6.0-pre.16` carry **incompatible envelope formats**, which is precisely the
confusion the pre-release line exists to avoid. `0.7.0`, with the `0.6` pre line retired.

## Migration must be observable, not a flag day

A stable release now requires validation against the pilot deployment, against **published
pre-releases** rather than `main`. That constrains the design, not just the rollout: a
one-shot flag day cannot be validated incrementally.

Therefore:

- **`_noydb: 2`** marks an AAD-bound envelope. The reader must **not** branch on it — see below.
- **A vault reports its format state.** A running deployment must be able to answer "is this
  vault on the old or new format, and how far along is any conversion" without reading records
  by hand.
- **Define the mixed case.** What a v2 client does with a v1 envelope, and vice versa, is a
  specified behaviour with a test, not an emergent one.

### The downgrade hole, and why the reader cannot branch on `_noydb`

`_noydb` is itself unauthenticated metadata. A reader that trusts it lets an attacker rewrite
`2` → `1` and switch AAD back off on demand. **AAD you can disable by editing a plaintext field
is not AAD.**

So the reader must never branch on it. The format state has to come from somewhere the store
cannot rewrite.

## Decision 5 — the format floor rides on DEK generation (#1043 pulled in)

Directed at the family root: #1043's roster anti-rollback is **in scope**, because a floor
anchored in a structure with a known rollback gap is not a floor. Investigating that produced a
smaller design rather than a larger one.

**`rotateKeys` already re-encrypts every record in the affected collections** — it decrypts
under the old DEK and re-encrypts under the new one (`with-party/team/keyring.ts`, the
`Re-encrypt all records in affected collections` loop). That is not an incidental
implementation detail; it is the mechanism that made revocation meaningful in #1054.

Therefore: **migrating a collection to format 2 IS a DEK rotation.** The consequences fall out
rather than needing to be built:

1. **Migration is atomic per collection.** Rotation rewrites every record, so afterwards the
   collection is entirely v2 under the new DEK. There is no mixed-format state *within* a
   collection, and therefore no per-record format decision to make.
2. **No floor field, no ratchet, no `_noydb` branch.** The reader passes AAD for any collection
   whose DEK is the post-migration one. It has no no-AAD code path for that collection, so there
   is nothing to downgrade *to*.
3. **A rolled-back keyring fails closed.** An old roster carries pre-rotation DEKs, which cannot
   open post-rotation records at all — the attacker gets a decryption failure, not a lenient
   read. This is what makes anchoring the floor in the keyring safe *despite* the roster being
   replayable.
4. **Migration stays observable and incremental.** The vault migrates collection by collection;
   each collection is atomically v1 or v2, and the per-collection DEK generation in the keyring
   is what a deployment reads to report progress. That satisfies the pre-release-soak
   requirement without a flag day.

### The invariant, stated rather than inherited

> **An old keyring cannot mis-describe a migrated collection, because the generation marker and
> the DEK travel together in the same KEK-authenticated file — and the DEK that accompanies a
> stale marker cannot decrypt the data that marker would mis-describe.**

This is a property of rotation re-encrypting, not of how the code happens to be arranged today.
If a future change makes rotation re-wrap DEKs *without* re-encrypting records, **this invariant
breaks silently and the downgrade hole reopens.** That is a guard-worthy claim: the harness must
assert it directly, not assume it.

What an attacker can still do is present a *consistent* old world — old roster plus old records
— which is **withholding**, not alteration, and is the head's job (Decision 3).

## The adversarial-store harness is part of the deliverable

`@noy-db/test-adapter-conformance` proves a store is *correct*. Nothing proves the client
survives a store that is *hostile*. Ship a sibling suite — a deliberately misbehaving store,
with the client asserted to fail closed on every row:

| Attack | Required behaviour | Closed by |
|---|---|---|
| re-serve old envelope, inflated `_v` | rejected **before** `local.put` | D1 + D2 |
| relocate into another collection/id | rejected | D2 |
| flip `_tier` to hide a record | rejected | D2 |
| forge `_by` / `_source` | rejected | D2 |
| downgrade `_noydb` 2 → 1 | rejected — no no-AAD path exists for a migrated collection | D5 |
| replay an old keyring to force v1 reads | rejected — its DEKs cannot open v2 records | D5 |
| rotation that re-wraps without re-encrypting | **the invariant itself is asserted** | D5 |
| withhold a record entirely | detected | head (opt-in) |
| suppress a `_keyring` delete | retained DEKs worthless | already closed (#1054) |

Because the head is opt-in, this is a **matrix**: each row asserted both with and without
`withVaultHead()`, with the without-head expectations matching `SECURITY.md` exactly. If the two
ever disagree, one of them is lying.

**Every row needs a test that fails when the protection is removed.** A completeness test that
has never been observed to fail is an unexecuted claim — the same standard applied to the
docs-bridge WIRING test in #1072, which was verified by adding a fake store and watching it fail.

Publish it beside `test-adapter-conformance` so noy-db-to, doi-db and third-party store authors
run the same suite. That also gives doi-db a testable definition of *"the daemon cannot rewind
you"* — which is its threat model, and why doi-db gates on this whole scheme rather than on
#1041 alone.

## Rollout

1. Finish **#1051** — one envelope construction site (13/49 producers migrated). AAD switches on
   *inside* `buildRecordEnvelope`, so this is the prerequisite that makes the change one line.
2. **#1041** — bind the tuple; `_noydb: 2`; the floor.
3. **#1042** — `MergeAuthority`, verify before `local.put`, `advance()` replaces the spread.
4. **#1044** — the head, as an opt-in service.
5. Adversarial harness, published.
6. Rail publishes **pre-releases**; pilot validates against the **published** artefacts.
7. **Promote the exact validated commit.** Do not rebuild from a moved `main` — the artefact
   shipped would not be the artefact tested, and the validation silently expires.

Acceptance criterion the family already holds: the pilot currently needs
`npm install --legacy-peer-deps` because of strict pre-release peers. A stable that deserves the
name installs **without** it.

## Open questions

1. ~~Where the format floor lives.~~ **Resolved by Decision 5** — the keyring, as a
   per-collection DEK generation, safe because rotation re-encrypts. No longer blocking.

   What remains of #1043 is the one un-probed question from the original report: **can `grant`
   ever mint a keyring broader than the user's later standing?** That is what would make a
   roster replay an *escalation* rather than a reinstatement, and it is unaffected by Decision 5
   because it concerns a roster that was legitimately minted. Needs a probe, and it is small.
2. **Tombstones and `_v` binding** (`engine.ts:974`). Empty body, nothing meaningful to
   authenticate. Bind them for uniformity, or exempt them explicitly and state why in the
   harness? An exemption is an attack surface if a tombstone can be replayed to suppress a
   live record.
3. **Head granularity and anti-entropy cost.** Per-vault manifest versus per-collection, and how
   often it is reconciled. Affects whether the head is usable on a large vault.

## Consequences

- One format break, not two. `0.7.0`.
- `check:architecture` is unchanged — if the implementation needs to weaken it, the design is wrong.
- `SECURITY.md`'s concession is replaced by a narrower true statement, and the harness matrix is
  what keeps the two honest.
- doi-db unblocks on the whole scheme, together with hub stable.
- If any of this changes a published subpath or the service catalog, that is a feature-registry
  obligation on noy-db-docs (`registry/features.yaml`) — coordination work, not silo work.
