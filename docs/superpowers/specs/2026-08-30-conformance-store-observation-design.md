# Design: observe the STORE, not the vault (#1211)

**Status:** design, not implementation. Preconditions verified 2026-08-30 (below).
**Issue:** noy-db #1211 · **Predecessor:** #1209 (the patch this replaces)

## 1. Preconditions — measured, not inherited

The issue names three. All were checked against artefacts rather than accepted
from the coordination layer's "gate met" declaration.

| # | precondition | status |
|---|---|---|
| 1 | noy-db-to / noy-db-ui / klum-db released on the 0.7 line | ✅ **MET** — `to-rest@next` and `ui@next` peer `^0.6.0-pre.0 \|\| ^0.7.0-pre.0`, `@klum-db/lobby@next` peers `^0.7.0-pre.0` |
| 2 | pilot consumer adopted | ✅ declared met at the root, resting on the pilot's own framing: clean on `0.7.0-pre.13`, one load-dependent flake, **a prerelease, not the 0.7 line** |
| 3 | `as-conformance-fixture` rule green across format packages | ✅ Check 16 in `check-architecture.mjs`, green |

⚠️ **Precondition 2 is the weakest of the three and the record should keep saying
so.** Adoption of a prerelease is not completion of the 0.7 line; there is no
`0.7.0` stable and `@latest` is still `0.6.0`. The deferral existed so the kit's
contract changes ONCE. That risk is now accepted deliberately rather than
resolved.

## 2. Contract-stability check (the condition the deferral existed for)

The instruction was to stop if the contract is still moving under the kit. It is
not, and here is the specific reasoning rather than an assurance:

- **#1274** (the `fieldMeta` guard moving to registration) touches `describe()`
  and collection construction. The kit observes **export gating and record
  reads**. Disjoint.
- **#1277** (mapped `match` hop) touches derivation fan-out. Disjoint.
- **#1227** (zod as an optional peer) touches schema derivation. Disjoint.
- **#1218's** error-shape change is complete through all four steps and
  published; the store contract itself has not moved since.

**The one thing that WOULD move it:** a change to the 6-method `NoydbStore`
contract, because this design makes the kit depend on store call SHAPES rather
than just their existence. None is proposed. If one appears, this design is what
has to be re-read.

## 3. What is wrong with the current observation

`denyGates` records calls to `vault.exportStream` — a **named method on the
vault**. #1209 happened precisely because an API reshape moved the gate out of
the place the observer was looking. Instance-patching survives *that* reshape and
is blind to the next one: an entry point that captures a context, or a hub
refactor reading through a different vault method.

**The denial half stays as it is.** It is attributable (the kit's own error
class) and loud-failing. Only the *observation* half changes.

## 4. The design

### 4.1 What is observed

A `NoydbStore` cannot be bypassed by any API reshape: every record leaving a
vault is bytes read from the store. The kit asserts on **store reads inside a
window**, not on a method name.

### 4.2 The fixture contract change, and why it must fail loud

Today `FormatFixture.vault()` returns a built vault and the kit never sees the
store. Option C requires the store, so the published contract changes.

```ts
readonly vault: () => Promise<Vault>                    // unchanged, still required
readonly observableVault?: () => Promise<{              // NEW
  readonly vault: Vault
  readonly store: NoydbStore                            // the SAME instance injected
}>
```

⛔ **The kit must NOT silently fall back to the lexical observation when
`observableVault` is absent.** A silent fallback is the exact failure this kit
exists to prevent — a package would appear conformant while being observed by the
weaker mechanism, and nothing in the output would say which one ran. Instead:

- absent → the before-reading assertion **fails** with a migration message
  naming `observableVault`;
- present → the structural assertion runs.

That makes the migration visible per package and finite, and it means "the suite
is green" continues to mean one thing.

### 4.3 Baseline and window — the decision the issue flagged

Store reads happen at `openVault` (keyring load, fence read) **before** any
export. Raw counting over-reports. Three candidates:

| approach | false pass |
|---|---|
| total count > 0 | passes on the keyring read alone — **the export could do nothing** |
| baseline after open, then delta | passes if any unrelated background read lands in the window |
| **window around the entry-point call** | passes only if a read happens *during* the call |

**Chosen: the window.** Start counting immediately before `entry.run(vault)` and
stop immediately after. It is the only one whose false-pass requires a read
*caused by the call*, which is the property being asserted.

⚠️ **And the window's own hazard, stated because it is the reason to prefer a
count over a boolean:** an export that reads a warm CACHE performs no store read
and would look like an export that read nothing. This is not hypothetical — it is
exactly the trap doi-db hit in its adversarial harness, where reads through the
original vault came from hub's warm cache and never reached the store. So:

- the fixture's vault must be built such that the exported records are NOT
  already resident (fresh vault per case is already the contract — §4.4 keeps it);
- the assertion is `reads > 0` **plus** a `reads === 0` control on a vault whose
  entry point is expected to be denied. A denial that also reads nothing is
  indistinguishable from a cache hit unless the positive case is proven to read.

### 4.4 What each existing property costs

- **Fresh vault per case** — already required, now load-bearing for a second
  reason (cache warmth, §4.3). The comment must say both, or someone will
  "optimise" the fixture to reuse a vault.
- **Denial by instance patch** — unchanged.
- **Per-entry ungated success check** — unchanged, and it becomes the honest
  control for §4.3's cache hazard.

## 5. Migration

1. Land the seam + the failing-when-absent assertion.
2. Migrate format packages one at a time; each is a fixture edit.
3. Extend `check-architecture` Check 16 to require `observableVault` once every
   package has it — the ratchet, not a flag day.

## 6. Explicitly out of scope

Replacing the denial mechanism. Changing the `NoydbStore` contract. Any change to
what the `as-*` packages themselves do.

## 7. Open question for implementation

Whether the kit wraps the fixture's store itself (kit-owned counting proxy) or
requires the fixture to hand back an already-wrapped store. **Prefer the former**
— a kit-owned proxy cannot be mis-implemented per package, and the fixture then
only has to expose the instance it already built. This should be settled with a
prototype against ONE format before the other nine are touched.
