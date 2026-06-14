# Fiscal-critical primitives: preview → stable + crypto audit (#378)

> **Status:** PLAN — readiness assessment + sequencing. Some flips are blocked
> on in-flight API-changing PRs (see § Sequencing).
> **Pilot:** Speedex bets Italian fiscal correctness on this set.

## What #378 asks

Move the primitives an e-invoicing app bets compliance on from `status: preview`
to `status: stable` (API freeze + test hardening) in `features.yaml`, and schedule
the independent crypto audit. All six are `preview` @ 0.2.0-pre.17 (confirmed).

## Readiness assessment

Test depth measured by `it`-block count + file count (2026-06-14, main):

| Feature | Tests | Files | Pilot-validated? | API churn in flight | Verdict |
|---|---|---|---|---|---|
| `money` | ~116 | 15 | ✅ niwat-validated (milestone 19) | none | **READY now** |
| `materialized-views` | ~75 | 12 | ✅ niwat (union-MV money) | i18n MV layer (#285 D2/D3) unwired | **READY** w/ caveat |
| `derivations` | ~84 | 19 | ✅ niwat (sibling sources #344) | **#376 adds `triggerBy`/`withRollup`** | **BLOCKED on #376** |
| `atomic-sequence` | ~23→33 | 1 | partial | **#375 adds `format`** | **BLOCKED on #375** |
| `computed` | ~15 | 3 | ✅ niwat (AU+027 #343) | none known | READY (light coverage) |
| `deferred-numbering` | ~12 | 1 | limited | #375 deferred-format follow-up | NOT YET (thin + pending shape) |

Notes:
- **money** is the strongest case — deepest coverage, conformance + encoding +
  guard-gate-parity + end-to-end suites, and a real fiscal consumer (niwat)
  validated it. Freeze-ready.
- **materialized-views** core is freeze-ready; the open item is the i18n `mv`/`join`
  resolution layer (#285 D2/D3), which is *additive* (doesn't change existing MV
  APIs). Recommend stabilizing the MV core and noting i18n-MV as a separate
  experimental sub-surface, OR waiting for #285 to close. Maintainer's call.
- **computed** has thin coverage (~15) for a fiscal-critical primitive (derived
  VAT/totals). Recommend a hardening pass (boundary/rounding/money-interaction
  cases) before the flip even though no API change is pending.
- **deferred-numbering** is thin (~12) and its `Assignment` shape may grow if the
  #375 deferred-format follow-up lands. Keep `preview`.

## ⚠️ Sequencing — the core risk

**Do not freeze an API you are about to extend.** Two pilot-2 PRs change the
surface of two of these features:

- **#375 (PR #380)** adds `format` + `FormattedSequenceHandle` to `atomic-sequence`.
- **#376** adds `triggerBy` / `withRollup` to `derivations`.

Freezing `sequence` or `derivations` to `stable` *before* those land would
immediately re-break a "stable" surface. Therefore:

```
Phase 0 (now):     money → stable. computed hardening pass → stable.
                   (materialized-views → stable, or hold for #285 — decision)
Phase 1:           land #375 (PR #380) → THEN atomic-sequence → stable
Phase 2:           land #376 (after its design decisions) → THEN derivations → stable
Phase 3:           deferred-numbering hardening (+ resolve #375 deferred-format) → stable
Crypto audit:      independent track — schedule now, not blocked on any of the above
```

The flips themselves are one-line `status:` edits in `features.yaml` — trivial.
The *work* is (a) the hardening passes (computed; deferred-numbering) and (b)
respecting the order so freezes are durable.

## API-freeze checklist (apply per feature before flipping)

1. Public surface reviewed — no `@internal` leaks, no soon-to-change params.
2. Error classes named + exported + documented (fiscal callers branch on them).
3. Conformance/boundary tests present (money: encoding; sequence: gap-free under
   contention + reset; computed: rounding/money interaction; mv: refresh atomicity).
4. Subsystem doc + at least one showcase.
5. `features.yaml` invariants block reflects the frozen contract.

## Crypto audit (independent of the above)

The encryption core (`crypto.ts`, keyring/DEK wrapping, per-record/per-blob CEK,
record-scoped sealing) gates *production* fiscal adoption, not development. This
is an **external engagement**, not a code change:

- Scope to fix: AES-256-GCM envelope + AAD binding, PBKDF2→KEK→AES-KW DEK chain,
  per-record CEK + crypto-shred (#304/#357), record-scoped sealing (#306/#360),
  per-blob CEK (#365).
- Deliverable: a tracked issue/milestone with scope doc + chosen auditor + target
  window. **This is a scheduling/process action for the maintainer** — I can draft
  the scope doc and the tracking issue body on request, but cannot engage an auditor.

## Recommended immediate action

1. Flip **money → stable** now (lowest-risk, highest pilot value, deepest coverage).
2. Decide **materialized-views**: stabilize core now vs hold for #285.
3. Queue a **computed** hardening pass, then flip.
4. Hold **sequence** / **derivations** flips until #375 / #376 land (sequencing).
5. Open the **crypto-audit** tracking issue (scope + auditor + window).

Each flip is a tiny `features.yaml` PR; the gating work is the hardening passes
and the ordering. None of this should block pilot *development* — `preview`
already lets the pilot build; it only gates their *ship*.
