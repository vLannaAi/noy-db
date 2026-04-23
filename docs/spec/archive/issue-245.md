# Issue #245 — feat(i18n): Thai fiscal-period primitives — BE-year conversion + Revenue Department deadline calendar

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.17.0 — Time partitioning & auditing
- **Labels:** type: feature, priority: high

---

Reported by pilot #1 (2026-04-23).

## Context

The pilot already ships hand-rolled helpers that every Thai-market noy-db consumer will reinvent:

- `useFormatPeriod("2026-03") → "03/2569"` — Gregorian → Buddhist Era period-key formatting
- Revenue Department filing deadlines encoded in CLAUDE.md:
  - **ภ.ง.ด.3** (PND.3 — personal income tax withholding): paper filing due **7th**, e-filing due **15th** of each month
  - **ภ.พ.30** (P.P.30 — VAT return): paper filing due **15th**, e-filing due **23rd** of each month

These are currently locked inside the pilot's codebase. Moving them into the noy-db ecosystem means:

1. **Every Thai-market consumer gets them free** — the accounting firm in Chiang Mai that noy-db was designed around is the first, but not the last.
2. **The period-closure primitive (#201 / #202) gains a typed Thai-specific period key source** — `vault.closePeriod({ periodKey: "2569-03", deadline: pnd3Deadline("2026-03", "efile") })` just works across the ecosystem.

## Proposed API surface

```ts
// BE year + period formatting
toBE(2026)                        // 2569
fromBE(2569)                      // 2026
formatBEPeriod("2026-03")         // "03/2569"  (MM/BEyyyy)
formatBEPeriod("2026-03", { form: "full" })  // "มีนาคม 2569"
parseBEPeriod("03/2569")          // "2026-03"  (round-trip)

// Revenue Department deadlines
pnd3Deadline("2026-03", "paper")  // Date — 2026-04-07
pnd3Deadline("2026-03", "efile")  // Date — 2026-04-15
pp30Deadline("2026-03", "paper")  // Date — 2026-04-15
pp30Deadline("2026-03", "efile")  // Date — 2026-04-23

// Well-typed period key (exported for the ecosystem)
type PeriodKey =
  | `${number}-${'0'|'1'}${number}`    // "2026-03" — monthly
  | `${number}-Q${1|2|3|4}`             // "2026-Q1" — quarterly
  | `${number}`                          // "2026"    — yearly

// Timezone helper (Asia/Bangkok is always the authoritative zone for RD deadlines)
THAI_TZ = "Asia/Bangkok"
```

## Where does this live?

**Three options, ordered by my preference:**

### Option A — New package `@noy-db/locale-th` (recommended)

Introduces a new `locale-` prefix to the ecosystem (fourth alongside `in-`, `to-`, `on-`). Semantically coherent: **locale-specific utilities that don't belong in the universal hub but do belong in the ecosystem**. Thin package (~300 LoC), peer-deps on hub, no runtime deps.

**Precedent**: this is the first locale-specific utility package. If we accept the `locale-` prefix, it opens the door for `@noy-db/locale-jp` (Japanese fiscal year = April to March), `@noy-db/locale-eu` (VAT quarter rules), etc. — each a narrow utility for a market.

**Tradeoff**: one more prefix to document in START_HERE.md + the shapes/patterns vocabulary.

### Option B — Subpath on `@noy-db/hub`: `@noy-db/hub/i18n/th`

Nested under the existing i18n subpath. Keeps the prefix count at three. Bloats hub/i18n with locale-specific code that non-Thai consumers tree-shake out (safe — the subpath is opt-in anyway).

**Tradeoff**: hub grows with per-locale modules. `hub/i18n/jp`, `hub/i18n/eu` would pile up. Not a clean stopping point.

### Option C — Fold into #201 / #202 period-closure issues

The period-closure implementation provides a hook for locale-specific period producers, and the pilot ships their Thai helpers as consumer code (not shared). Simplest, but defeats the "every Thai-market consumer gets it free" goal the feedback explicitly calls out.

## Recommendation

**Option A.** The `locale-` prefix is clean, the package is small, and pilot #1 has already signaled that pilots #2 and #3 in the Thai market will want these too. Better to establish the pattern now than retrofit.

## Cross-references

- **#201** period closure — consumes `PeriodKey` type + timezone helper
- **#202** period opening — same
- **#203** showcase financial year-end closure workflow — natural place to demo BE formatting and RD deadlines
- **Existing** `@noy-db/hub/i18n` (dictKey + i18nText) — uses the `Asia/Bangkok` TZ concept; sibling package
- **#36** Thai wizard prompts (closed) — precedent for Thai-first ecosystem features

## Scope for this issue

1. New package `packages/locale-th/` scaffolded like on-oidc / on-webauthn (package.json, tsup, tsconfig, vitest, src/index.ts, __tests__)
2. The 7 primitives above, each with vitest coverage
3. `PeriodKey` type exported — consumed by #201 / #202 when they land
4. README: one-page reference documenting BE conversion, RD deadline table, timezone behavior, how to integrate with period closure
5. Add `Fork · Locales` milestone as an always-open home for future `locale-*` packages (like Fork · On, Fork · Stores, Fork · Integrations)

Size: 1 day. Dependencies on #201 are soft (type export; real integration happens when #201 lands).
