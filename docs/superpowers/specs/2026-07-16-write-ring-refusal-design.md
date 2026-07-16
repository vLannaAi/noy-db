# Arc 5 — The write ring: refuse tier-0 writes to elevated records (#715 + #716)

**Issues:** [#715](https://github.com/vLannaAi/noy-db/issues/715) (put ring) · [#716](https://github.com/vLannaAi/noy-db/issues/716) (delete ring)
**Predecessors (merged):** #700, #710, #714, #717 — the tier-0 **read** surface is fully law-compliant.

## The problem this closes

The read campaign's law — *elevated (`_tier > 0`) records are invisible on tier-0 surfaces* — is **self-defeating on the write path**. Invisibility tells a tier-0 writer "the record isn't there"; a `put()` that believes it treats the id as a **create**, and a create at tier 0 **is a demotion**. So the very gates that hide the record are what let it be silently stripped.

Both filed bypasses are instances of this, and both **defeat the read gates already shipped**:

- **#715** — `put()` over an elevated id **silently demotes** it to tier 0 (`_tier` 1 → undefined, verified), no clearance check, no `CrossTierAccessEvent`. Its lazy inline prior read (`collection.ts` ~1915–1926) additionally writes a **history snapshot of the elevated plaintext** (warm), which then passes #712's live-peek *because the put just demoted the record*; cold it throws `InvalidKeyError` out of `put()`. The CRDT branch (~1815–1864, three ungated decrypts at :1824/:1836/:1863) instead **throws warm and cold** — no demotion, no leak, but a bricked put + error oracle.
- **#716** — `delete()` writes a marker/tombstone that carries **no `_tier`**, erasing the elevation signal, so an elevated record's history **re-decrypts** through #712's live-peek. (`forget()` is immune — it destroys the CEK, so protection is cryptographic, not a metadata check.)

Every read gate rests on the premise *"the live envelope's `_tier` is trustworthy."* The write ring falsifies that premise. It must be closed before further read gates are worth building.

## Decision (user-approved 2026-07-16): refuse uniformly

**A tier-0 `put()` / `delete()` whose target's LIVE envelope has `_tier > 0` is refused with one uniform error — regardless of the caller's clearance.** Holders are refused too: `put()`/`delete()` are the tier-0 APIs; the sanctioned tier-aware paths are `putAtTier()` / `elevate()` / `demote()` (all of which bypass `_putInternal`/`_doDelete` and are unaffected).

**Rejected — tier-aware write (preserve tier):** would resolve tier DEKs inside the kernel write path, the exact layering the read campaign rejected (`getDEK` **auto-mints** unheld keys; with-audit is opt-in). It also still refuses non-holders, so it buys convenience for holders at the cost of a new kernel↔tier seam.

**Accepted cost — a write-side existence oracle.** A `put()` to an elevated id throws where a `put()` to a missing id creates, so a tier-0 writer learns the id exists and is elevated. Defensible: `_tier` is already cleartext to the untrusted store, and the campaign already accepts gate handlers seeing it (`resolveGatePrior` keeps `env`). This is the deliberate trade — **integrity over write-side existence-hiding**; the read surface stays fully invisible.

## Design

**Choke points — two, and they cover everything.** The refusal goes at the top of `_putInternal` (`collection.ts:1727`) and `_doDelete` (`:2667`), immediately after the `hasWritePermission` check and **before the gate bus dispatch** (so gate handlers never fire for a refused write) and before any prior read. This makes all seven ungated sites **unreachable** rather than individually gated:

| Site | Path | Dies because |
|---|---|---|
| `_putInternal` inline lazy read (~1915–1926) | non-CRDT lazy | never reached |
| CRDT decrypts :1824 / :1836 / :1863 | CRDT put | never reached |
| `_doDelete` lazy decrypt (~2708–2712) | lazy delete | never reached |
| marker/tombstone write | delete | no marker is written → **#716's bypass dies** |

**Cost gate — free unless tiers are on.** Guard the check with `this.tiers !== null` (`collection.ts:502`, declaration-activated). Collections that never declare tiers pay **zero**; tiered collections pay one extra `adapter.get` per write. Acceptable: tiers is opt-in, and correctness on a confidentiality feature outranks one envelope peek. (Note: the eager cache cannot answer this — post-#701 it is elevated-free, so an elevated record reads as *absent* there. The peek must hit the adapter.)

**Reuse:** `liveRecordIsElevated` already exists in `kernel/tier-visibility.ts` (shipped by #717, envelope peek, zero decryption). The new assertion belongs beside it — collection.ts is at its exact ceiling, and this is precisely the extraction the ratchet exists to force.

**New error type.** Neither existing type fits: `TierNotGrantedError` says *"User has no DEK for tier N"* (wrong — we refuse holders too) and `TierAccessDeniedError` is documented as read-path/invisibility-ghost only. Add a dedicated, actionable error to `kernel/errors.ts` naming the remedy (`putAtTier`/`elevate`/`demote`). Public API addition → changeset-worthy.

## Scope

**In:** public `put()` (all modes: eager, lazy, CRDT) and public `delete()`; the new error; tests proving each of the seven sites is unreachable and that #716's bypass is closed.

**Out (investigate + report, do not fix):**
- `_doDelete(id, internal: true)` — the internal path (derivation/MV cleanup). Refusing it could break legitimate cleanup; allowing it may leave a marker-write path to an elevated record. Report whether internal deletes can reach an elevated record.
- `forget()` / `_writeTombstone` (`:2863`) — reviewer-verified safe (destroys the CEK → history undecryptable by design). Report whether it should nonetheless refuse for integrity symmetry.
- Sync-apply / migration writes → **#708**'s ring. Indexing → **#709**. History at-rest → **#712**.

## Constraints

- Ceiling (exact zero slack): `collection.ts` **4548** (checker 4549 = wc-l + 1). Expect ~+3 (import + two call sites) → fund with mechanical, semantics-preserving shrink-joins, each documented and reviewer-verified. Never edit ceiling values; `vault.ts`/`noydb.ts` untouched.
- Zero-knowledge invariant untouched: the refusal *reads no key material* — envelope inspection only.
- `putAtTier`/`elevate`/`demote`/`getAtTier`/`listAtTier` behavior unchanged (verify by regression: the existing tiers suites must pass untouched).
- Behavior change is intended and user-approved: `put()`/`delete()` now throw where they previously succeeded (non-CRDT) or threw a crypto error (CRDT). The changeset must state it plainly.
