# Issue #57 — Refresh SVG infographics for v0.4 + new positioning

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** none
- **Labels:** type: docs, priority: low, area: docs

---

## Scope

The README positioning pass (PR #57) introduced new framing (serverless, runs-on-any-device, Thailand focus) and expanded the package list through v0.4.1. The existing SVG infographics in \`docs/assets/\` are technically accurate for the v0.2 + v0.3 core story but are **incomplete** against the current state:

- **\`architecture.svg\`** — data flow diagram is still correct, but doesn't show the v0.4 hash-chained ledger layer or the v0.4 schema-validation hook point.
- **\`deployment-profiles.svg\`** — 8 profiles are still valid but v0.3+ introduced Nuxt 4, Pinia, and \`@noy-db/create\` which aren't depicted. No explicit "mobile / PWA" profile call-out either.
- **\`end-user-features.svg\`** — consumer-facing benefits tile; still reads correctly but doesn't mention the v0.4 verifiability story.
- **\`key-hierarchy.svg\`** and **\`envelope-format.svg\`** — fundamentals, unchanged, still accurate.
- **\`brand.svg\`** — pure logo, no text. OK as-is.

## Why this is a follow-up

SVG editing via text manipulation is error-prone (I tried it during the v0.3 docs sweep and ended up with broken layouts). This is a design task — requires either Figma/Illustrator + export, or a proper SVG authoring tool with layout snapping.

The README itself compensates with the new markdown platform matrix (which renders everywhere without an SVG) and inline tables for key hierarchy, envelope format, and package matrix. So the SVGs aren't load-bearing for the README's core message — they're decorative enhancement.

## Suggested deliverables

1. **\`architecture-v04.svg\`** — add a ledger/audit-log swim lane between the CRYPTO LAYER and the ADAPTER INTERFACE boxes. Label it \`LEDGER (hash-chained)\`.
2. **\`deployment-profiles-v04.svg\`** — add profile 9 (Nuxt 4 + Pinia) and profile 10 (Mobile PWA) to the existing grid.
3. **\`end-user-features-v04.svg\`** — add a "Tamper-evident history" tile for v0.4.
4. Leave \`key-hierarchy.svg\`, \`envelope-format.svg\`, \`brand.svg\` unchanged.

## Estimate

S–M (depends on whether the designer reuses the existing visual language or starts fresh).
