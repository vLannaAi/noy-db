# ADR 0003: Store integrity — untrusted for ordering, not just confidentiality

> **Status:** **accepted** 2026-08-14 (#1071 — the design gate on #1041, #1042, #1044).
> **Date:** 2026-08-14. MADR-lite, per ADR 0001.
>
> Accepted after the no-legacy premise below replaced the coexistence half of the design.
> #1041, #1042 and #1044 are unblocked and may land in that order.

## Context

`@noy-db/hub` claims the storage backend is untrusted. That claim is currently true for
**confidentiality** and false for **integrity of ordering and placement**, and `SECURITY.md`
has to concede it in one sentence:

> A remote store — or a `by-peer` peer — is trusted for the integrity of version ordering and
> envelope placement, while being untrusted for confidentiality.

**The purpose of this work is to delete that sentence honestly.** Not to narrow it.

### The premise that shapes everything below: there is nothing to be compatible with

**Directed by the user, 2026-08-14.** No production deployment and no existing vault holds data
in the current envelope format. The pilot rebuilds its pod programmatically. The published
`0.6.0-pre.*` line carries no durable state anywhere.

Therefore this ADR **replaces** the format. It does not migrate to a new one. No legacy path, no
deprecation window, no coexistence — consistent with the family's standing no-legacy-alias
policy, applied here to the wire format itself.

That is not a shortcut, and it is worth being explicit about why it makes the result *safer*
rather than merely cheaper. Roughly half of an integrity scheme's complexity is coexistence:
two formats alive at once means every reader needs a branch, and **every branch is a lever an
attacker can steer**. The classic failure is the downgrade — flip a plaintext marker, get the
weaker path. A design with one format has no such lever, because there is no weaker path to
select. *An earlier draft of this ADR spent an entire decision closing that hole; deleting
coexistence deleted the hole instead.*

One check makes the scope concrete: **`_noydb` is stamped by ~49 producers and read by nothing.**
No reader in `packages/hub/src` branches on it. So the format marker was never load-bearing, and
it does not become load-bearing here.

The AES-GCM auth tag covers the record body (`_data`). The sibling fields — `_v`, `_ts`, `_by`,
`_source`, `_tier`, `_noydb` — sit outside the AEAD and carry no integrity, so a store can
rewrite them and the tag still verifies. Reproduced: re-serving an old envelope with an inflated
`_v` overwrites the client's newer data, `pull()` reports zero errors, no exception is raised.

### Why one scheme, not three staged fixes

Decided at the family root on 2026-08-12 and not reopened here. Two reasons, the second being
the real one:

1. ~~**Staging risks a second format break.**~~ **This plank is withdrawn.** It was costed in
   *migration*, and under the no-legacy premise a second format break inside the pre line costs
   nothing. Stating it honestly: the original anti-staging argument was half financial, and that
   half has evaporated.
2. **It is the premise, not hardening.** A store untrusted for confidentiality but trusted for
   ordering is a hole in the product's central claim. Unaffected, and now carrying the argument
   alone.
3. **Design coherence, which survives independently of cost.** #1041 must choose what to bind;
   #1044 needs a stable notion of record identity to anchor on. Freezing the tuple before the
   anchor's requirements are known risks binding the wrong thing — and that is a *correctness*
   risk, not a migration bill. It already paid off once: settling the anchor first is what
   shrank #1044 from a Merkle chain to an `{id → version}` manifest.

**So the conclusion is unchanged but the footing is narrower**, and worth knowing if staging is
ever reconsidered: it is now defended on coherence and premise, not on expense.

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
| raise `_tier` to hide a record | ⚠️ **NOT rejected — see below** |
| lower `_tier` to expose an elevated record | rejected (wrong DEK) |
| forge `_by` / `_source` | rejected |

Note this holds for a **fresh device with no prior state** — the client recomputes AAD from the
envelope's own claimed metadata, so it needs no local copy to compare against. Bootstrap, which
earlier analyses listed as uncovered, is covered.

`_ts` is deliberately excluded: it is advisory, and binding it would make legitimate clock
correction a tamper event.

### ⚠️ Correction, 2026-08-15: raising `_tier` is WITHHOLDING, not alteration

An earlier draft of this table claimed *"flip `_tier` to hide a record → rejected"*. **It is not
rejected**, and the adversarial harness found that within minutes of first running — which is the
argument for building the harness rather than reasoning about the table.

Raising `_tier` never reaches AAD. The tier-0 read gate treats any envelope claiming `_tier > 0`
as **missing** and returns before decrypting (`collection.ts`), so the record simply comes back
`null` — hidden, which is the outcome the row said was closed.

**Reordering cannot fix it.** A reader holding only the tier-0 DEK has no way to distinguish a
*genuinely* elevated record from a faked one: both fail under the key it has. So an upward
re-tier is **withholding**, and withholding is exactly what `SECURITY.md` still concedes without
`withVaultHead()` (#1044).

Lowering `_tier` *is* rejected, because that direction reaches the crypto: a tier-N body
relabelled tier 0 is opened with the tier-0 DEK, which is not the key it was sealed under.

Both directions are pinned as separate harness rows measuring the real behaviour, rather than one
row asserting a defence that does not exist.

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

## Decision 4 — the stable is `0.6.0`

**Reversed from this ADR's first draft, which said `0.7.0`.** The reason given there was that
`0.6.0-pre.*` shipped a format the stable would not use, so a `0.6.0` stable would carry an
envelope format incompatible with its own pre-line. That reason rests entirely on someone
holding data in the pre-line format. Under the premise above, nobody does — pre-releases are
explicitly unstable, and changing the format between `0.6.0-pre.17` and `0.6.0` breaks no
promise that was made.

What decided it is the coordination cost, measured rather than estimated. Every satellite peer
range is already `^0.6.0-pre.*`:

| repo | declared range | admits `0.6.0`? | admits `0.7.0`? |
|---|---|---|---|
| noy-db-to | `^0.6.0-pre.0`, `^0.6.0-pre.11` | ✅ | ❌ |
| klum-db | `^0.6.0-pre.14` | ✅ | ❌ |
| noy-db-ui | `^0.6.0-pre.0` | ✅ | ❌ |

`^0.6.0-pre.0` desugars to `>=0.6.0-pre.0 <0.7.0`, so **a `0.6.0` stable needs zero manifest
edits anywhere in the family.** `0.7.0` would require appending `|| ^0.7.0` in three repos and
republishing all three — and the family record documents a *half-finished* append
(`"^0.6.0-pre.0 || "`) as a real hazard that silently floors at `0.0.0` and admits every version
while looking almost right in a diff.

So `0.7.0` would buy a signal nobody needs, at the price of three coordinated edits whose known
failure mode is an unbounded peer range. `0.6.0`.

## Decision 5 — replace the format; there is no migration

*The first draft of this ADR made Decision 5 "the format floor rides on DEK generation", pulling
in #1043, and carried three blockers (B1 adoption, B2 field-dropping rotation, B3 crash-unsafe
rotation). All of that existed to make **coexistence** safe. Under the no-legacy premise there is
no coexistence, so the decision is replaced rather than amended. What follows is the whole of it.*

- **AAD is unconditional.** Every record envelope is written and read with the Decision 2 tuple
  bound. There is no opt-out, no per-collection state, and no "is this collection converted yet"
  question — because nothing predates the change.
- **The reader never branches on `_noydb`.** It does not branch on it today (verified: no reader
  in `packages/hub/src` consults it), and it must not start. `_noydb` stays a plaintext
  provenance marker at its current value, useful for "is this blob ours" and load-bearing for
  nothing. **AAD you can disable by editing a plaintext field is not AAD** — the way to keep that
  true is to have no code path it could select.
- **Anything sealed under the old format is unreadable and that is correct.** A pre-`0.6.0`
  envelope fails AAD verification and is rejected. That is the intended behaviour, not an edge
  case to soften: a lenient path for unbound envelopes *is* the downgrade hole.
- **No migration tooling ships.** No converter, no format-progress reporting, no mixed-format
  specification, no flag day to schedule.

### What this deleted, recorded so it is not rebuilt

The retired blockers were real findings, and two of them were **fixed and shipped in
`0.6.0-pre.17`** on their own merits — they were live revocation defects, not merely migration
prerequisites:

| | was | now |
|---|---|---|
| **B1** adoption re-wraps a DEK without re-encrypting | would have made an adopted partition read as old-format — a downgrade needing no attacker | **dissolved** — no format state to carry |
| **B2** rotation dropped `_by`/`_tier`/`_cek`/`_sealed`/`_vdig`/`_source` | AAD unreconstructible after rotation; silent re-tier to 0 | **fixed** (#1074/#1075, `rekeyEnvelopeToDek`) |
| **B3** rotation not crash-safe | interrupted rotation left records under a DEK never persisted — permanently unreadable | **fixed** (#1074 part 2, pending-DEK-before-loop) |

B2 and B3 were worth fixing regardless: since #1054 removed `rotateKeys: false`, rotation is the
**only** revocation path, so both defects fired on every revocation on every published version.
The no-legacy premise removed their role in *this* design; it did not make them not-bugs.

**#1043 is no longer pulled in.** Its roster-replay concern was in scope only because a format
floor anchored in the keyring inherited it. With no floor, the remaining half of #1043 is one
un-probed question about current code — see Open Questions.

## The adversarial-store harness is part of the deliverable

`@noy-db/test-adapter-conformance` proves a store is *correct*. Nothing proves the client
survives a store that is *hostile*. Ship a sibling suite — a deliberately misbehaving store,
with the client asserted to fail closed on every row:

| Attack | Required behaviour | Closed by |
|---|---|---|
| re-serve old envelope, inflated `_v` | rejected **before** `local.put` | D1 + D2 |
| relocate into another collection/id | rejected | D2 |
| raise `_tier` to hide a record | ⚠️ **withheld, not rejected** — see Decision 2 | head (opt-in) |
| lower `_tier` to expose an elevated record | rejected | D2 |
| forge `_by` / `_source` | rejected | D2 |
| edit `_noydb` to any value | **no effect** — nothing reads it | D5 |
| serve an unbound (pre-`0.6.0`) envelope | rejected — no lenient path exists | D5 |
| adopt a partition, then tamper with it | rejected — AAD survives re-homing (`vault` unbound by design) | D2 + D5 |
| withhold a record entirely | detected | head (opt-in) |
| suppress a `_keyring` delete | retained DEKs worthless | already closed (#1054) |
| interrupt a revocation mid-rotation | resumable; no record becomes unreadable | shipped (#1074) |

Four rows from the first draft are gone — `_noydb` downgrade, old-keyring replay to force
old-format reads, rotation-that-re-wraps-without-re-encrypting, and interrupted *migration*.
Each tested a coexistence property that no longer exists. **They were deleted, not silently
dropped:** if coexistence is ever reintroduced, they come back with it.

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

1. ~~Finish **#1051** — AAD switches on *inside* `buildRecordEnvelope`, making the change one
   line.~~ **DONE (#1051 closed), and the second half of that sentence was WRONG.** Corrected
   2026-08-15, by checking instead of assuming — the same failure this ADR catalogues elsewhere.

   `buildRecordEnvelope(identity, body)` receives **already-encrypted** `iv`/`data`. AAD is an
   argument to `subtle.encrypt`. The constructor never touches plaintext, so it is physically
   incapable of applying AAD. The real choke points are:

   | | sites | state after #1051 |
   |---|---|---|
   | **write** — `encrypt(json, dek, aad?)` | 44 | already accepts AAD; identity is **in scope at every one**, which is what #1051 bought |
   | **read** — `openEnvelopeJson(env, key)` | 41 | **takes no identity at all** |
   | **read** — direct `decrypt(...)` | 21 | same |

   **#1051 was not wasted — it is what makes the write side mechanical.** But it solved envelope
   *construction* fan-out, and AAD is applied at *encryption*, which is a different set.

   **The read side is the hard half and was never scoped.** AES-GCM is symmetric in AAD: a reader
   must supply byte-identical AAD or decryption fails. Several read paths — query execution, sync
   merge, backup restore, `loadAll` — hold only an envelope, having discarded the collection/id
   they came from. That is a data-flow change, not a crypto change.

   **What bounds it:** `_tier` and `_by` live *on the envelope*, so a reader only needs
   `{collection, id}` threaded — exactly what it passed to `store.get`. Binding still works
   against tampering: an attacker who flips `_tier` changes the AAD the reader computes, and
   decryption fails. So the threading is bounded to two fields, not four.

   **Consequence for planning:** this is days, not hours, and it must be **atomic** — a
   partially-bound database is not a valid state, so there is no safe intermediate to ship. The
   adversarial harness lands with it, not after.
2. **#1041** — bind the tuple, unconditionally. No format flag, no floor, no ratchet.
3. **#1042** — `MergeAuthority`, verify before `local.put`, `advance()` replaces the spread.
4. **#1044** — the head, as an opt-in service.
5. Adversarial harness, published.
6. Rail publishes **pre-releases**; pilot validates against the **published** artefacts.
7. **Promote the exact validated commit.** Do not rebuild from a moved `main` — the artefact
   shipped would not be the artefact tested, and the validation silently expires.

Steps 2–4 are one format, landed once. Because no vault predates them they may land across
several `0.6.0-pre.*` cuts without any inter-version compatibility obligation between those
pre-releases — the pilot re-seeds from scratch on each. **That is a property of the pre line
only, and it ends at `0.6.0`.**

Acceptance criterion the family already holds: the pilot currently needs
`npm install --legacy-peer-deps` because of strict pre-release peers. A stable that deserves the
name installs **without** it.

## Open questions

1. ~~Where the format floor lives.~~ **Dissolved by Decision 5** — there is no floor, because
   there is no second format to floor against.

   What remains of #1043 is the one un-probed question from the original report: **can `grant`
   ever mint a keyring broader than the user's later standing?** That would make a roster replay
   an *escalation* rather than a reinstatement. It concerns a roster that was **legitimately
   minted**, so it is untouched by the no-legacy premise and by Decision 5 alike. Small,
   self-contained, needs a probe rather than a design.
2. **Tombstones and `_v` binding** (`engine.ts:974`). Empty body, nothing meaningful to
   authenticate. Bind them for uniformity, or exempt them explicitly and state why in the
   harness? An exemption is an attack surface if a tombstone can be replayed to suppress a
   live record.
3. **Head granularity and anti-entropy cost.** A per-vault `{id → version}` manifest written per
   commit is write amplification proportional to vault size — potentially unusable on exactly the
   large deployment that most needs it. Size this **early**: if per-vault does not scale,
   per-collection changes the manifest's shape, and shape decisions are cheap now and expensive
   later.

4. ~~Migration cost.~~ **Dissolved** — nothing is converted. The pilot re-seeds.

5. **Should `_noydb` exist at all?** It costs bytes on every record and, as established above,
   no reader consults it. Keeping it is defensible as a "is this blob ours" sentinel for stores
   and tooling. Removing it touches ~49 producers and a public type. **Not decided here** — it is
   a separate simplification, and bundling it into an integrity change would make both harder to
   review.

## Consequences

- One format, landed once, at `0.6.0` — and **zero satellite manifest edits**, since every peer
  range already admits it.
- **Anything written by `0.6.0-pre.*` becomes unreadable.** Accepted deliberately under the
  premise above; it is the cost that buys the deletion of every coexistence branch.
- `check:architecture` is unchanged — if the implementation needs to weaken it, the design is wrong.
- `SECURITY.md`'s concession is replaced by a narrower true statement, and the harness matrix is
  what keeps the two honest.
- doi-db unblocks on the whole scheme, together with hub stable.
- If any of this changes a published subpath or the service catalog, that is a feature-registry
  obligation on noy-db-docs (`registry/features.yaml`) — coordination work, not silo work.
