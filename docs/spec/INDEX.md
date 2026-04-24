# noy-db Spec Archive

This directory is the **in-repo preservation layer** for the project's
feature specifications, design rationale, acceptance criteria,
trade-off discussions, and merge history that originally lived on
GitHub.

The **code contains the implementation**; this archive contains the
*why*. Source-of-truth for every ship decision, rejected alternative,
and acceptance checklist — frozen as markdown and grep-able.

## Layout

```
docs/spec/
├── INDEX.md              ← this file (entry point)
├── archive/              ← one file per issue
│   └── issue-N.md
├── milestones/           ← one file per milestone
│   └── NNN-slug.md
├── discussions/          ← one file per GitHub Discussion
│   └── discussion-N.md
└── prs/                  ← one file per pull request
    └── pr-N.md
```

## Grep recipe

```sh
grep -l "to-postgres" docs/spec/archive   # find related issues
grep -l "to-postgres" docs/spec/prs       # find related PRs
grep -rl "casAtomic"  docs/spec           # find every mention
```

Last rebuilt on 2026-04-23 from filesystem scan.

| Category | Count |
|---|---:|
| Issues archived | 184 |
| Milestones archived | 26 |
| Discussions archived | 16 |
| Pull requests archived | 59 |

---

## Milestones

| # | Title | State | Closed | Open | File |
|---:|---|:-:|---:|---:|---|
| 1 | v0.3.0 | closed | 13 | 0 | [001-v0-3-0.md](./milestones/001-v0-3-0.md) |
| 2 | v0.4.0 | closed | 15 | 0 | [002-v0-4-0.md](./milestones/002-v0-4-0.md) |
| 3 | v0.5.0 | closed | 8 | 0 | [003-v0-5-0.md](./milestones/003-v0-5-0.md) |
| 4 | v0.6.0 | closed | 9 | 0 | [004-v0-6-0.md](./milestones/004-v0-6-0.md) |
| 5 | v0.7.0 | closed | 8 | 0 | [005-v0-7-0.md](./milestones/005-v0-7-0.md) |
| 6 | v0.8.0 | closed | 5 | 0 | [006-v0-8-0.md](./milestones/006-v0-8-0.md) |
| 7 | v0.9.0 | closed | 6 | 0 | [007-v0-9-0.md](./milestones/007-v0-9-0.md) |
| 8 | v0.11.0 | closed | 1 | 0 | [008-v0-11-0.md](./milestones/008-v0-11-0.md) |
| 9 | v0.12.0 | closed | 10 | 0 | [009-v0-12-0.md](./milestones/009-v0-12-0.md) |
| 10 | v0.10.0 | closed | 7 | 0 | [010-v0-10-0.md](./milestones/010-v0-10-0.md) |
| 11 | Fork · Stores (@noy-db/to-*) | open | 5 | 4 | [011-fork-stores-noy-db-to.md](./milestones/011-fork-stores-noy-db-to.md) |
| 12 | Fork · Integrations (@noy-db/in-*) | open | 7 | 2 | [012-fork-integrations-noy-db-in.md](./milestones/012-fork-integrations-noy-db-in.md) |
| 13 | Fork · On (@noy-db/on-*) | open | 0 | 1 | [013-fork-on-noy-db-on.md](./milestones/013-fork-on-noy-db-on.md) |
| 14 | Showcases | closed | 11 | 0 | [014-showcases.md](./milestones/014-showcases.md) |
| 15 | v0.13.0 — Developer tools (P1) | closed | 8 | 0 | [015-v0-13-0-developer-tools-p1.md](./milestones/015-v0-13-0-developer-tools-p1.md) |
| 16 | v0.17.0 — Time partitioning & auditing | closed | 5 | 0 | [016-v0-17-0-time-partitioning-auditing.md](./milestones/016-v0-17-0-time-partitioning-auditing.md) |
| 17 | v0.18.0 — Hierarchical access levels | closed | 6 | 0 | [017-v0-18-0-hierarchical-access-levels.md](./milestones/017-v0-18-0-hierarchical-access-levels.md) |
| 18 | v0.14.0 — Playground expansion (P2) | closed | 1 | 0 | [018-v0-14-0-playground-expansion-p2.md](./milestones/018-v0-14-0-playground-expansion-p2.md) |
| 19 | v0.15.0 — Pre-distribution & documentation (P3) | closed | 6 | 0 | [019-v0-15-0-pre-distribution-documentation-p3.md](./milestones/019-v0-15-0-pre-distribution-documentation-p3.md) |
| 20 | v0.16.0 — Advanced core features | closed | 5 | 0 | [020-v0-16-0-advanced-core-features.md](./milestones/020-v0-16-0-advanced-core-features.md) |
| 21 | v0.19.0 — Advanced crypto & privacy | closed | 2 | 0 | [021-v0-19-0-advanced-crypto-privacy.md](./milestones/021-v0-19-0-advanced-crypto-privacy.md) |
| 22 | v0.20.0 — Edge & realtime | closed | 1 | 0 | [022-v0-20-0-edge-realtime.md](./milestones/022-v0-20-0-edge-realtime.md) |
| 23 | v0.15.1 — Hub refactor (backward-compat) | closed | 7 | 0 | [023-v0-15-1-hub-refactor-backward-compat.md](./milestones/023-v0-15-1-hub-refactor-backward-compat.md) |
| 24 | v0.15.2 — First adoption patch (pilot #1 feedback) | closed | 4 | 0 | [024-v0-15-2-first-adoption-patch-pilot-1-feedback.md](./milestones/024-v0-15-2-first-adoption-patch-pilot-1-feedback.md) |
| 25 | Fork · As (@noy-db/as-*) | open | 0 | 0 | [025-fork-as-noy-db-as.md](./milestones/025-fork-as-noy-db-as.md) |
| 26 | v0.17.1 Good to have scaffolding | closed | 4 | 0 | [026-v0-17-1-good-to-have-scaffolding.md](./milestones/026-v0-17-1-good-to-have-scaffolding.md) |

## Discussions

| # | Title | Category | Comments | File |
|---:|---|---|---:|---|
| 60 | Welcome to noy-db Discussions! | Announcements | 0 | [discussion-60.md](./discussions/discussion-60.md) |
| 64 | Query DSL: joins across collections (using v0.4 refs as the anchor) | Ideas | 2 | [discussion-64.md](./discussions/discussion-64.md) |
| 65 | Query DSL: aggregations (count, sum, avg, min, max, groupBy) | Ideas | 4 | [discussion-65.md](./discussions/discussion-65.md) |
| 66 | SQL query frontend — should noy-db ship one at all? | Ideas | 1 | [discussion-66.md](./discussions/discussion-66.md) |
| 67 | Binary attachment store: encrypted blobs (PDF, CSV, images) alongside records | Ideas | 2 | [discussion-67.md](./discussions/discussion-67.md) |
| 70 | Plaintext exports (JSON / CSV / xlsx / MySQL?) — scope boundary and core primitive | Ideas | 4 | [discussion-70.md](./discussions/discussion-70.md) |
| 78 | i18n as a first-class primitive: normalized dictionary keys + multi-lang content fields + translator hook | Ideas | 1 | [discussion-78.md](./discussions/discussion-78.md) |
| 86 | Partitioned collections: per-partition DEKs, closed-period integrity, and carry-forward snapshots | Ideas | 1 | [discussion-86.md](./discussions/discussion-86.md) |
| 92 | .noydb container format: wrapping compartment.dump() with an opaque-handle header | Ideas | 1 | [discussion-92.md](./discussions/discussion-92.md) |
| 93 | Bundle adapter shape: a second adapter interface for blob-store backends (Drive, Dropbox, iCloud) | Ideas | 1 | [discussion-93.md](./discussions/discussion-93.md) |
| 94 | @noy-db/drive: Google Drive bundle adapter (OAuth + opaque-handle filenames) | Ideas | 1 | [discussion-94.md](./discussions/discussion-94.md) |
| 95 | Sync scheduling: how often should a bundle adapter push and pull? | Ideas | 1 | [discussion-95.md](./discussions/discussion-95.md) |
| 96 | Reader: ship as CLI extension + browser extension (not PWA) | Ideas | 1 | [discussion-96.md](./discussions/discussion-96.md) |
| 117 | v0.7 unlock flow: passphrase as root, LINE/WebAuthn/OTP as convenience, timeout model, passphrase drill vs rotation | Ideas | 0 | [discussion-117.md](./discussions/discussion-117.md) |
| 137 | Multi-backend topology: sync as an array with per-target role and policy | Ideas | 0 | [discussion-137.md](./discussions/discussion-137.md) |
| 138 | Adapter probe: simulation-based suitability test for guiding backend role selection | Ideas | 0 | [discussion-138.md](./discussions/discussion-138.md) |

## Pull Requests

| # | Title | State | Merged | File |
|---:|---|:-:|:-:|---|
| 1 | Refine roadmap v2: architecture diagrams and deployment profiles | MERGED | 2026-04-05 | [pr-1.md](./prs/pr-1.md) |
| 2 | chore(release): version packages | CLOSED | — | [pr-2.md](./prs/pr-2.md) |
| 3 | chore(release): version packages | CLOSED | — | [pr-3.md](./prs/pr-3.md) |
| 4 | docs: restructure roadmap, add architecture + deployment profiles, plan v0.3 | MERGED | 2026-04-06 | [pr-4.md](./prs/pr-4.md) |
| 5 | chore(workflow): governance — PR/issue templates, label catalog, expanded CODEOWNERS | MERGED | 2026-04-06 | [pr-5.md](./prs/pr-5.md) |
| 19 | feat(core): reactive query DSL | MERGED | 2026-04-06 | [pr-19.md](./prs/pr-19.md) |
| 20 | feat(pinia): defineNoydbStore + Vue/Pinia playground | CLOSED | — | [pr-20.md](./prs/pr-20.md) |
| 21 | ci: trigger on vX.Y-dev branches and stacked feat/* PRs | MERGED | 2026-04-06 | [pr-21.md](./prs/pr-21.md) |
| 22 | feat(pinia): defineNoydbStore + Vue/Pinia playground | MERGED | 2026-04-06 | [pr-22.md](./prs/pr-22.md) |
| 23 | feat(pinia): createNoydbPiniaPlugin — augmentation path | MERGED | 2026-04-06 | [pr-23.md](./prs/pr-23.md) |
| 24 | feat(core): secondary indexes for the query DSL | MERGED | 2026-04-06 | [pr-24.md](./prs/pr-24.md) |
| 25 | feat(core+adapters): listPage extension + Collection.scan() streaming | MERGED | 2026-04-06 | [pr-25.md](./prs/pr-25.md) |
| 26 | feat(core): lazy hydration + LRU eviction | MERGED | 2026-04-06 | [pr-26.md](./prs/pr-26.md) |
| 27 | feat(nuxt): @noy-db/nuxt — Nuxt 4 module | MERGED | 2026-04-06 | [pr-27.md](./prs/pr-27.md) |
| 28 | feat(playground): Nuxt 4 reference demo + nuxt module runtime fix | MERGED | 2026-04-06 | [pr-28.md](./prs/pr-28.md) |
| 29 | docs: v0.3 sweep — Pinia/Nuxt happy path + fix @noydb/* scope (closes #17) | MERGED | 2026-04-06 | [pr-29.md](./prs/pr-29.md) |
| 30 | release: v0.3.0 — Pinia-first DX + query & scale (closes #18, closes #6) | MERGED | 2026-04-07 | [pr-30.md](./prs/pr-30.md) |
| 31 | v0.3.0 — Pinia-first DX + query & scale (closes epic #6) | MERGED | 2026-04-07 | [pr-31.md](./prs/pr-31.md) |
| 32 | chore: remove broken changesets-driven release flow | MERGED | 2026-04-07 | [pr-32.md](./prs/pr-32.md) |
| 33 | feat(create-noy-db): wizard + noy-db CLI — closes #7, closes #9 | MERGED | 2026-04-07 | [pr-33.md](./prs/pr-33.md) |
| 34 | fix(create-noy-db): rename to @noy-db/create — NPM_TOKEN scope fix | MERGED | 2026-04-07 | [pr-34.md](./prs/pr-34.md) |
| 35 | fix(@noy-db/create): v0.3.2 — move core + memory to runtime deps | MERGED | 2026-04-07 | [pr-35.md](./prs/pr-35.md) |
| 47 | feat(core+pinia): schema validation via Standard Schema v1 (closes #42) | MERGED | 2026-04-07 | [pr-47.md](./prs/pr-47.md) |
| 48 | feat(core): hash-chained audit log (closes #43) | MERGED | 2026-04-07 | [pr-48.md](./prs/pr-48.md) |
| 49 | feat(core): delta history via RFC 6902 JSON Patch (closes #44) | MERGED | 2026-04-07 | [pr-49.md](./prs/pr-49.md) |
| 50 | feat(core): foreign-key references via ref() (closes #45) | MERGED | 2026-04-07 | [pr-50.md](./prs/pr-50.md) |
| 51 | feat(core): verifiable backups (closes #46) | MERGED | 2026-04-07 | [pr-51.md](./prs/pr-51.md) |
| 52 | docs(v0.4): sweep — schema, ledger, deltas, refs, verifiable backups | MERGED | 2026-04-07 | [pr-52.md](./prs/pr-52.md) |
| 53 | release: v0.4.0 — Integrity & trust | MERGED | 2026-04-07 | [pr-53.md](./prs/pr-53.md) |
| 54 | v0.4.0 — Integrity & trust (closes epic #41) | MERGED | 2026-04-07 | [pr-54.md](./prs/pr-54.md) |
| 55 | fix(release): v0.4.1 — peer dep pinning made v0.4.0 uninstallable | MERGED | 2026-04-07 | [pr-55.md](./prs/pr-55.md) |
| 56 | chore(post-v0.4): cleanup — docs, CONTRIBUTING, stale drafts | MERGED | 2026-04-07 | [pr-56.md](./prs/pr-56.md) |
| 58 | docs(readme): reposition as serverless + data-ownership; Thailand focus | MERGED | 2026-04-07 | [pr-58.md](./prs/pr-58.md) |
| 59 | ci: e2e scaffolder matrix (closes #40) | MERGED | 2026-04-07 | [pr-59.md](./prs/pr-59.md) |
| 61 | feat(create-noy-db+core): rotate / add-user / backup CLI (closes #38) | MERGED | 2026-04-07 | [pr-61.md](./prs/pr-61.md) |
| 68 | feat(create-noy-db): wizard augment mode for existing Nuxt 4 (closes #37) | MERGED | 2026-04-07 | [pr-68.md](./prs/pr-68.md) |
| 69 | docs: CLI reference + augment mode + AI reference update | MERGED | 2026-04-07 | [pr-69.md](./prs/pr-69.md) |
| 71 | feat(create): Thai i18n for the wizard (#36) | MERGED | 2026-04-07 | [pr-71.md](./prs/pr-71.md) |
| 77 | docs(roadmap): @noy-db/decrypt-* package family + plaintext export policy | MERGED | 2026-04-07 | [pr-77.md](./prs/pr-77.md) |
| 79 | docs(roadmap): rescope v0.5, add v0.6 query-DSL, slip identity to v0.7 | MERGED | 2026-04-07 | [pr-79.md](./prs/pr-79.md) |
| 80 | docs(spec+roadmap): v0.8 i18n epic + plaintext-exit invariant clarification | MERGED | 2026-04-07 | [pr-80.md](./prs/pr-80.md) |
| 88 | feat(core): exportStream() + exportJSON() — authorization-aware plaintext export (closes #72) | MERGED | 2026-04-07 | [pr-88.md](./prs/pr-88.md) |
| 89 | feat(core): admin can grant another admin — bounded lateral delegation (closes #62) | MERGED | 2026-04-07 | [pr-89.md](./prs/pr-89.md) |
| 90 | feat(core+memory+file): cross-compartment role-scoped queries (closes #63) | MERGED | 2026-04-07 | [pr-90.md](./prs/pr-90.md) |
| 91 | release: v0.5.0 — Core enhancements + scaffolder polish | CLOSED | — | [pr-91.md](./prs/pr-91.md) |
| 115 | feat(core): Query DSL .join() — eager single-FK joins (closes #73) | MERGED | 2026-04-09 | [pr-115.md](./prs/pr-115.md) |
| 116 | feat(core): .join().join() multi-FK chaining (closes #75) | CLOSED | — | [pr-116.md](./prs/pr-116.md) |
| 120 | feat(core): Query.live() reactive primitive with merged join change-streams (closes #74) | MERGED | 2026-04-09 | [pr-120.md](./prs/pr-120.md) |
| 121 | feat(core): aggregation reducers + .aggregate() + .live() (closes #97) | MERGED | 2026-04-09 | [pr-121.md](./prs/pr-121.md) |
| 122 | feat(core): .groupBy(field) + .groupBy().aggregate() (closes #98) | MERGED | 2026-04-09 | [pr-122.md](./prs/pr-122.md) |
| 123 | feat(core): scan().aggregate() — streaming memory-bounded aggregation (closes #99) | MERGED | 2026-04-09 | [pr-123.md](./prs/pr-123.md) |
| 124 | feat(core): scan().join() — streaming join over scan() (closes #76) | MERGED | 2026-04-09 | [pr-124.md](./prs/pr-124.md) |
| 125 | feat(core+file): .noydb container format — magic header + opaque handle + compressed body (closes #100) | MERGED | 2026-04-09 | [pr-125.md](./prs/pr-125.md) |
| 126 | feat(core): identity & sessions — session tokens, policies, sync-credentials, magic-link, dev-unlock | MERGED | 2026-04-09 | [pr-126.md](./prs/pr-126.md) |
| 127 | feat: add @noy-db/auth-webauthn — WebAuthn + PRF hardware-key keyrings | MERGED | 2026-04-09 | [pr-127.md](./prs/pr-127.md) |
| 128 | feat: add @noy-db/auth-oidc — OAuth/OIDC bridge with split-key connector | MERGED | 2026-04-09 | [pr-128.md](./prs/pr-128.md) |
| 129 | feat(core): dictKey/DictionaryHandle + i18nText schema types (v0.8 #81 #82) | CLOSED | — | [pr-129.md](./prs/pr-129.md) |
| 130 | feat(core): v0.8 i18n completion — plaintextTranslator, export dict snapshot, query dictKey | MERGED | 2026-04-09 | [pr-130.md](./prs/pr-130.md) |
| 161 | feat(hub): v0.12 storage structure — blob store, syncPolicy, multi-backend | MERGED | 2026-04-10 | [pr-161.md](./prs/pr-161.md) |

> **Note on PR deletion:** GitHub does not permit deleting closed
> pull requests — they are tied to branch history and merge commits.
> The PRs above are preserved here as markdown and can be optionally
> `gh pr lock <n>`'d on the remote to prevent further comments,
> but the PR numbers themselves remain visible on GitHub forever.

## Issues (grouped by milestone)

🟢 = still open on GitHub. Files without the badge may have been
deleted from GitHub after archival — the content here remains
authoritative.

### Fork · As (@noy-db/as-*)

- [#107 — Issue #107 — feat(as-sql): @noy-db/as-sql — SQL dump export for migration (postgres/mysql/sqlite)](./archive/issue-107.md) · 2026-04-23
- [#246 — Issue #246 — feat(as-xlsx): @noy-db/as-xlsx — Excel spreadsheet plaintext export with ACL-scoped rows + audit entry](./archive/issue-246.md) · 2026-04-22
- [#247 — Issue #247 — feat(as-csv): @noy-db/as-csv — CSV plaintext export (simplest of the as-* family)](./archive/issue-247.md) · 2026-04-21
- [#248 — Issue #248 — feat(as-xml): @noy-db/as-xml — XML plaintext export for legacy systems + accounting software](./archive/issue-248.md) · 2026-04-23
- [#249 — Issue #249 — RFC(as-*): two-tier authorization model — canExportPlaintext + canExportBundle](./archive/issue-249.md) · 2026-04-22
- [#250 — Issue #250 — feat(as-json): @noy-db/as-json — structured JSON export with audit gate + browser/node helpers](./archive/issue-250.md) · 2026-04-23
- [#251 — Issue #251 — feat(as-ndjson): @noy-db/as-ndjson — newline-delimited JSON for streaming large vaults](./archive/issue-251.md) · 2026-04-23
- [#252 — Issue #252 — feat(as-noydb): @noy-db/as-noydb — encrypted .noydb bundle export (encrypted tier of as-*)](./archive/issue-252.md) · 2026-04-23
- [#254 — Issue #254 — feat(as-blob): @noy-db/as-blob — single-attachment plaintext export (document sub-family)](./archive/issue-254.md) · 2026-04-22
- [#255 — Issue #255 — feat(as-zip): @noy-db/as-zip — composite record+blob archive (document sub-family)](./archive/issue-255.md) · 2026-04-22

### Fork · Integrations (@noy-db/in-*)

- [#186 — Issue #186 — feat(in-react): @noy-db/in-react — hooks (useNoydb, useCollection, useQuery, useSync)](./archive/issue-186.md) · 2026-04-23
- [#187 — Issue #187 — feat(in-svelte): @noy-db/in-svelte — reactive stores](./archive/issue-187.md) · 2026-04-23
- [#188 — Issue #188 — feat(in-solid): @noy-db/in-solid — signals](./archive/issue-188.md) 🟢 · 2026-04-21
- [#189 — Issue #189 — feat(in-qwik): @noy-db/in-qwik — resumable queries](./archive/issue-189.md) 🟢 · 2026-04-21
- [#190 — Issue #190 — feat(in-tanstack-query): @noy-db/in-tanstack-query — queryFn adapter](./archive/issue-190.md) · 2026-04-23
- [#191 — Issue #191 — feat(in-tanstack-table): @noy-db/in-tanstack-table — bridge for useSmartTable pattern](./archive/issue-191.md) · 2026-04-23
- [#192 — Issue #192 — feat(in-zustand): @noy-db/in-zustand — store factory mirroring defineNoydbStore](./archive/issue-192.md) · 2026-04-23
- [#216 — Issue #216 — feat(in-ai): @noy-db/in-ai — LLM function-calling adapter with ACL-scoped tool definitions](./archive/issue-216.md) · 2026-04-23
- [#259 — Issue #259 — feat(in-nextjs): @noy-db/in-nextjs — Next.js App Router helpers](./archive/issue-259.md) · 2026-04-23

### Fork · On (@noy-db/on-*)

- [#193 — Issue #193 — feat(on-recovery): @noy-db/on-recovery — one-time recovery codes](./archive/issue-193.md) · 2026-04-21
- [#194 — Issue #194 — feat(on-totp): @noy-db/on-totp — TOTP (RFC 6238) authenticator app unlock](./archive/issue-194.md) · 2026-04-23
- [#195 — Issue #195 — feat(on-email-otp): @noy-db/on-email-otp — email OTP with SMTP + customizable mail template](./archive/issue-195.md) · 2026-04-23
- [#196 — Issue #196 — feat(on-threat): multi-attempt lockout policy — N wrong passphrases → lock / cooldown / wipe](./archive/issue-196.md) · 2026-04-23
- [#197 — Issue #197 — feat(on-threat): duress passphrase — data-destruct mode](./archive/issue-197.md) · 2026-04-23
- [#198 — Issue #198 — feat(on-threat): duress passphrase — honeypot vault (deceptive decoy data)](./archive/issue-198.md) · 2026-04-23
- [#220 — Issue #220 — feat(on-shamir): @noy-db/on-shamir — k-of-n secret-sharing of the KEK for multi-party unlock](./archive/issue-220.md) · 2026-04-21
- [#236 — Issue #236 — feat(on-magic-link): extract hub/session magic-link helpers into @noy-db/on-magic-link](./archive/issue-236.md) · 2026-04-21
- [#237 — Issue #237 — feat(on-biometric): extract hub/biometric.ts or fold into @noy-db/on-webauthn after review](./archive/issue-237.md) · 2026-04-21
- [#238 — Issue #238 — feat(on-pin): new @noy-db/on-pin — session-resume PIN / biometric quick-lock](./archive/issue-238.md) · 2026-04-21
- [#257 — Issue #257 — feat(delegation): cross-user KEK exchange for v0.18 #209 — follow-up](./archive/issue-257.md) 🟢 · 2026-04-23

### Fork · Stores (@noy-db/to-*)

- [#104 — Issue #104 — feat(to-drive): @noy-db/to-drive — Google Drive bundle store with OAuth + opaque handles](./archive/issue-104.md) · 2026-04-23
- [#108 — Issue #108 — feat(adapters): SQL-backed adapters — @noy-db/to-postgres + @noy-db/to-mysql (encrypted-blob KV)](./archive/issue-108.md) · 2026-04-23
- [#142 — Issue #142 — feat(to-icloud): @noy-db/to-icloud — iCloud Drive bundle store](./archive/issue-142.md) · 2026-04-23
- [#144 — Issue #144 — feat(to-smb): @noy-db/to-smb — SMB/CIFS network file store](./archive/issue-144.md) · 2026-04-23
- [#145 — Issue #145 — feat(to-nfs): @noy-db/to-nfs — NFS network file store](./archive/issue-145.md) · 2026-04-23
- [#176 — Issue #176 — feat(to-cloudflare-r2): @noy-db/to-cloudflare-r2 — S3-compatible KV, no egress fees](./archive/issue-176.md) · 2026-04-23
- [#177 — Issue #177 — feat(to-cloudflare-d1): @noy-db/to-cloudflare-d1 — SQLite at the edge](./archive/issue-177.md) · 2026-04-23
- [#178 — Issue #178 — feat(to-supabase): @noy-db/to-supabase — Postgres + storage combo](./archive/issue-178.md) · 2026-04-23
- [#179 — Issue #179 — feat(to-sqlite): @noy-db/to-sqlite — single-file SQLite KV for 10K+ records](./archive/issue-179.md) · 2026-04-23
- [#180 — Issue #180 — feat(to-turso): @noy-db/to-turso — edge SQLite with replication](./archive/issue-180.md) · 2026-04-23
- [#181 — Issue #181 — feat(to-webdav): @noy-db/to-webdav — bundle store for Nextcloud / ownCloud / any WebDAV](./archive/issue-181.md) · 2026-04-23
- [#182 — Issue #182 — feat(to-ipfs): @noy-db/to-ipfs — content-addressed bundle store](./archive/issue-182.md) 🟢 · 2026-04-21
- [#183 — Issue #183 — feat(to-git): @noy-db/to-git — vault as git repo, history as commits](./archive/issue-183.md) 🟢 · 2026-04-21
- [#184 — Issue #184 — feat(to-postgres): @noy-db/to-postgres — Postgres KV with jsonb column (KV-pattern, separate from #107 SQL migration)](./archive/issue-184.md) · 2026-04-23
- [#185 — Issue #185 — feat(to-mysql): @noy-db/to-mysql — MySQL KV with json column](./archive/issue-185.md) · 2026-04-23
- [#213 — Issue #213 — feat(to-qr): @noy-db/to-qr — encrypted vault export to scannable QR sequence](./archive/issue-213.md) 🟢 · 2026-04-21
- [#221 — Issue #221 — feat(to-stego): @noy-db/to-stego — steganographic bundle store (ciphertext hidden in JPEG/PNG/PDF)](./archive/issue-221.md) 🟢 · 2026-04-21
- [#258 — Issue #258 — feat(to-ssh): @noy-db/to-ssh — SSH/SFTP store with public-key auth](./archive/issue-258.md) · 2026-04-23

### Showcases

- [#165 — Issue #165 — Showcase scaffold: package.json, vitest config, CFN template](./archive/issue-165.md) · 2026-04-20
- [#166 — Issue #166 — Showcase 01: Accounting Day (Pinia)](./archive/issue-166.md) · 2026-04-20
- [#167 — Issue #167 — Showcase 02: Multi-user Access (Node.js)](./archive/issue-167.md) · 2026-04-20
- [#168 — Issue #168 — Showcase 03: Store Routing (Node.js)](./archive/issue-168.md) · 2026-04-20
- [#169 — Issue #169 — Showcase 04: Sync Two Offices (Vue)](./archive/issue-169.md) · 2026-04-20
- [#170 — Issue #170 — Showcase 05: Blob Document Lifecycle (Node.js)](./archive/issue-170.md) · 2026-04-20
- [#171 — Issue #171 — Showcase 06: Cascade Delete FK (Nuxt+Pinia)](./archive/issue-171.md) · 2026-04-20
- [#172 — Issue #172 — Showcase 07: Query Analytics (Pinia)](./archive/issue-172.md) · 2026-04-20
- [#173 — Issue #173 — Showcase 08: Resilient Middleware (Node.js)](./archive/issue-173.md) · 2026-04-20
- [#174 — Issue #174 — Showcase 09: Encrypted CRDT (Yjs)](./archive/issue-174.md) · 2026-04-20
- [#175 — Issue #175 — Showcase 10: Cloud DynamoDB (Nuxt)](./archive/issue-175.md) · 2026-04-20

### v0.10.0

- [#139 — Issue #139 — fix(browser): IndexedDB CAS not atomic — split readwrite transactions allow concurrent clobber](./archive/issue-139.md) · 2026-04-09
- [#140 — Issue #140 — refactor(core): rename adapter → store across packages and public API](./archive/issue-140.md) · 2026-04-09
- [#141 — Issue #141 — feat(core): StoreCapabilities.casAtomic + NoydbOptions.acknowledgeRisks](./archive/issue-141.md) · 2026-04-09
- [#143 — Issue #143 — feat(core): StoreCapabilities.auth — authentication kind and flow metadata per store](./archive/issue-143.md) · 2026-04-09
- [#147 — Issue #147 — rename: Compartment → Vault across the public API](./archive/issue-147.md) · 2026-04-09
- [#148 — Issue #148 — refactor(stores): rename store-dynamo → store-aws-dynamo](./archive/issue-148.md) · 2026-04-09
- [#149 — Issue #149 — refactor(stores): rename store-s3 → store-aws-s3 and drop MinimalS3Client abstraction](./archive/issue-149.md) · 2026-04-09

### v0.11.0

- [#150 — Issue #150 — chore: rename all packages — hub, in-*, to-*](./archive/issue-150.md) · 2026-04-10

### v0.12.0

- [#39 — Issue #39 — Templates: Vite+Vue, Electron, vanilla (non-Nuxt)](./archive/issue-39.md) · 2026-04-10
- [#101 — Issue #101 — feat(core): syncPolicy — debounce / interval / on-change scheduling for bundle adapters](./archive/issue-101.md) · 2026-04-10
- [#102 — Issue #102 — feat(cli+ext): .noydb reader — CLI commands + browser extension (not PWA)](./archive/issue-102.md) · 2026-04-10
- [#103 — Issue #103 — feat(core): NoydbBundleAdapter interface — second adapter shape for blob-store backends](./archive/issue-103.md) · 2026-04-10
- [#105 — Issue #105 — feat(core): encrypted binary attachment store — blobs alongside records](./archive/issue-105.md) · 2026-04-10
- [#146 — Issue #146 — feat(tooling): @noy-db/store-probe — setup-time suitability test and runtime reliability monitor for all attached stores](./archive/issue-146.md) · 2026-04-10
- [#158 — Issue #158 — feat(core): multi-backend topology — SyncTarget[] with role and per-target policy](./archive/issue-158.md) · 2026-04-10
- [#162 — Issue #162 — feat(core): split-store routing — records to DynamoDB, blobs to S3 (tiered storage topology)](./archive/issue-162.md) · 2026-04-10
- [#163 — Issue #163 — feat(core): ephemeral routing — runtime store override for shared devices and restricted networks](./archive/issue-163.md) · 2026-04-10
- [#164 — Issue #164 — feat(core): routing & blob enhancements — write-behind queue, auto-health, middleware, presigned URLs, lifecycle policies](./archive/issue-164.md) · 2026-04-10

### v0.13.0 — Developer tools (P1)

- [#106 — Issue #106 — feat(core): naked mode — opt-in plaintext storage for debugging (dev-only, heavy guardrails)](./archive/issue-106.md) · 2026-04-21
- [#151 — Issue #151 — feat(cli): .noydb reader CLI — inspect, open, verify](./archive/issue-151.md) · 2026-04-21
- [#153 — Issue #153 — feat(tooling): @noy-db/store-probe — setup-time suitability test](./archive/issue-153.md) · 2026-04-21
- [#154 — Issue #154 — feat(tooling): @noy-db/store-probe — runtime reliability monitor](./archive/issue-154.md) · 2026-04-21
- [#157 — Issue #157 — feat(scaffolder): template — vanilla (Vite + hub + to-browser-idb, no framework)](./archive/issue-157.md) · 2026-04-21
- [#160 — Issue #160 — feat(tooling): store-probe — multi-backend topology health and suitability](./archive/issue-160.md) · 2026-04-21
- [#199 — Issue #199 — feat(tools): runtime monitor — live dashboard for vault metrics, sync status, health](./archive/issue-199.md) · 2026-04-21
- [#200 — Issue #200 — feat(tools): configuration validator / generator — sanity-check NoydbOptions + emit .env templates](./archive/issue-200.md) · 2026-04-21

### v0.14.0 — Playground expansion (P2)

- [#211 — Issue #211 — showcase: dictionary + i18n translation multi-locale demo](./archive/issue-211.md) · 2026-04-21

### v0.15.0 — Pre-distribution & documentation (P3)

- [#223 — Issue #223 — docs(entry-point): consolidate SPEC.md + architecture.md + topology-matrix.md into a single reader-facing entry doc](./archive/issue-223.md) · 2026-04-21
- [#224 — Issue #224 — docs(i18n): Thai translation of README + docs/guides/START_HERE.md + architecture.md + topology-matrix.md](./archive/issue-224.md) · 2026-04-21
- [#225 — Issue #225 — docs(presentation): slide deck explaining noy-db in 20 slides (problem → architecture → showcases → adoption)](./archive/issue-225.md) · 2026-04-21
- [#226 — Issue #226 — docs(roadmap): rewrite ROADMAP.md for trunk + forks structure](./archive/issue-226.md) · 2026-04-21
- [#227 — Issue #227 — docs(api-audit): decide auth- vs on- prefix for authentication packages — consistency audit + migration plan](./archive/issue-227.md) · 2026-04-21
- [#228 — Issue #228 — Overview SVG Infographic.](./archive/issue-228.md) · 2026-04-21

### v0.15.1 — Hub refactor (backward-compat)

- [#229 — Issue #229 — refactor(hub): subpath exports — additive opt-in for hub/store, hub/i18n, hub/team, hub/session, hub/ledger, hub/query](./archive/issue-229.md) · 2026-04-21
- [#230 — Issue #230 — refactor(hub/store): group document-storage code into packages/hub/src/store/](./archive/issue-230.md) · 2026-04-21
- [#231 — Issue #231 — refactor(hub/i18n): group dictionary + i18n code into packages/hub/src/i18n/](./archive/issue-231.md) · 2026-04-21
- [#232 — Issue #232 — refactor(hub/team): group sync + multi-user keyring into packages/hub/src/team/](./archive/issue-232.md) · 2026-04-21
- [#233 — Issue #233 — refactor(hub/session): group session tokens + policies into packages/hub/src/session/](./archive/issue-233.md) · 2026-04-21
- [#234 — Issue #234 — refactor(hub/ledger): group hash-chained ledger + diff + patch + bundle-format into packages/hub/src/ledger/](./archive/issue-234.md) · 2026-04-21
- [#235 — Issue #235 — docs(hub-subpaths): update START_HERE.md + topology-matrix.md + CLAUDE.md for the hub subpath layout](./archive/issue-235.md) · 2026-04-21

### v0.15.2 — First adoption patch (pilot #1 feedback)

- [#241 — Issue #241 — docs(schema): schema validator at collection.put() exists — document it prominently + audit every entry point](./archive/issue-241.md) · 2026-04-21
- [#243 — Issue #243 — feat(core): collection.subscribe(cb) — ergonomic all-records change stream](./archive/issue-243.md) · 2026-04-21
- [#244 — Issue #244 — docs(conflict-resolution): cookbook — how to register a resolver, defaults, LWW vs merge-fields, multi-operator scenarios](./archive/issue-244.md) · 2026-04-21
- [#253 — Issue #253 — meta: Pilot 1 fast-lane tracker — 11 issues, 4 phases, ~7 weeks critical path](./archive/issue-253.md) · 2026-04-22

### v0.16.0 — Advanced core features

- [#215 — Issue #215 — feat(core): time-machine queries — db.at(timestamp).collection(...).get(id) via hash-chained ledger](./archive/issue-215.md) · 2026-04-21
- [#217 — Issue #217 — feat(core): shadow vaults — read-only preview/presentation mode that cannot write back](./archive/issue-217.md) · 2026-04-21
- [#218 — Issue #218 — feat(core): consent boundaries — per-access audit log with { actor, purpose, consent_hash }](./archive/issue-218.md) · 2026-04-21
- [#240 — Issue #240 — feat(core): transactional multi-record writes — db.transaction(async (tx) => { ... })](./archive/issue-240.md) · 2026-04-21
- [#242 — Issue #242 — feat(core): bulk operations — collection.putMany() / getMany() / deleteMany()](./archive/issue-242.md) · 2026-04-21

### v0.17.0 — Time partitioning & auditing

- [#201 — Issue #201 — feat(ledger): period closure — seal records as closed accounting period, immutable after close](./archive/issue-201.md) · 2026-04-21
- [#202 — Issue #202 — feat(ledger): period opening — carry-forward balances for new period](./archive/issue-202.md) · 2026-04-21
- [#203 — Issue #203 — showcase: financial year-end closure workflow](./archive/issue-203.md) · 2026-04-21
- [#204 — Issue #204 — showcase: audit trail — cross-period hash-chain verification](./archive/issue-204.md) · 2026-04-22
- [#245 — Issue #245 — feat(i18n): Thai fiscal-period primitives — BE-year conversion + Revenue Department deadline calendar](./archive/issue-245.md) · 2026-04-21

### v0.17.1 Good to have scaffolding

- [#155 — Issue #155 — feat(scaffolder): template — vite-vue (Vite + Vue 3 + Pinia + to-browser-idb)](./archive/issue-155.md) · 2026-04-21
- [#156 — Issue #156 — feat(scaffolder): template — electron (Electron + Vue 3 + to-file, USB workflow)](./archive/issue-156.md) · 2026-04-22
- [#159 — Issue #159 — feat(scaffolder): wizard — multi-backend setup (primary + sync targets)](./archive/issue-159.md) · 2026-04-22
- [#239 — Issue #239 — showcase: #15 email archive — MIME .eml ingest + threading + cid-rendering](./archive/issue-239.md) · 2026-04-22

### v0.18.0 — Hierarchical access levels

- [#205 — Issue #205 — feat(core): nested security levels — per-record classification tier](./archive/issue-205.md) · 2026-04-23
- [#206 — Issue #206 — feat(core): data elevation — promote record to higher tier](./archive/issue-206.md) · 2026-04-23
- [#207 — Issue #207 — feat(core): invisibility mode — records above user tier return NOT_FOUND](./archive/issue-207.md) · 2026-04-23
- [#208 — Issue #208 — feat(core): ghost mode — records above user tier return placeholder needing elevation](./archive/issue-208.md) · 2026-04-23
- [#209 — Issue #209 — feat(core): temporary access delegation — time-boxed cross-tier grant](./archive/issue-209.md) · 2026-04-23
- [#210 — Issue #210 — feat(audit): real-time notification on cross-tier access + logging](./archive/issue-210.md) · 2026-04-23

### v0.19.0 — Advanced crypto & privacy

- [#219 — Issue #219 — feat(crypto): deterministic encryption mode — searchable encrypted indexes, opt-in only](./archive/issue-219.md) · 2026-04-23
- [#222 — Issue #222 — feat(crypto): zero-knowledge proofs for compliance — prove properties without revealing values](./archive/issue-222.md) · 2026-04-23

### v0.20.0 — Edge & realtime

- [#214 — Issue #214 — feat(p2p): @noy-db/p2p — WebRTC peer-to-peer sync (no server in the middle)](./archive/issue-214.md) · 2026-04-23

### v0.3.0

- [#6 — v0.3 — Pinia-first DX + query & scale (tracking epic)](./archive/issue-6.md) · 2026-04-07
- [#7 — `create-noy-db` — guided scaffolder](./archive/issue-7.md) · 2026-04-07
- [#8 — `@noy-db/nuxt` — Nuxt 4 module](./archive/issue-8.md) · 2026-04-06
- [#9 — `nuxi noydb <command>` extension](./archive/issue-9.md) · 2026-04-07
- [#10 — `defineNoydbStore` — greenfield Pinia path](./archive/issue-10.md) · 2026-04-06
- [#11 — `createNoydbPiniaPlugin` — augmentation path](./archive/issue-11.md) · 2026-04-06
- [#12 — Reactive query DSL in `@noy-db/core`](./archive/issue-12.md) · 2026-04-06
- [#13 — Encrypted secondary indexes](./archive/issue-13.md) · 2026-04-06
- [#14 — Paginated `listPage()` and streaming `scan()`](./archive/issue-14.md) · 2026-04-06
- [#15 — Lazy collection hydration + LRU eviction](./archive/issue-15.md) · 2026-04-06
- [#16 — Reference Nuxt 4 accounting demo in `playground/nuxt/`](./archive/issue-16.md) · 2026-04-06
- [#17 — Docs updates for v0.3](./archive/issue-17.md) · 2026-04-06
- [#18 — Changeset, release prep, and `v0.3.0` publish](./archive/issue-18.md) · 2026-04-07

### v0.4.0

- [#41 — v0.4 — Integrity & trust](./archive/issue-41.md) · 2026-04-07
- [#42 — Issue #42 — Schema validation via Standard Schema v1](./archive/issue-42.md) · 2026-04-07
- [#43 — Issue #43 — Hash-chained audit log (ledger)](./archive/issue-43.md) · 2026-04-07
- [#44 — Issue #44 — Delta history via RFC 6902 JSON Patch](./archive/issue-44.md) · 2026-04-07
- [#45 — Issue #45 — Foreign-key references via ref()](./archive/issue-45.md) · 2026-04-07
- [#46 — Issue #46 — Verifiable backups](./archive/issue-46.md) · 2026-04-07

### v0.5.0

- [#36 — Issue #36 — i18n: Thai + English prompts for @noy-db/create wizard](./archive/issue-36.md) · 2026-04-07
- [#37 — Issue #37 — magicast: wizard patches existing nuxt.config.ts](./archive/issue-37.md) · 2026-04-07
- [#38 — Issue #38 — noy-db CLI: rotate, seed, backup, add user subcommands](./archive/issue-38.md) · 2026-04-07
- [#40 — Issue #40 — E2E CI matrix for @noy-db/create](./archive/issue-40.md) · 2026-04-07
- [#62 — Issue #62 — Allow admin to grant another admin (bounded delegation)](./archive/issue-62.md) · 2026-04-07
- [#63 — Issue #63 — Cross-compartment role-scoped queries: listAccessibleCompartments + queryAcross](./archive/issue-63.md) · 2026-04-07
- [#72 — Issue #72 — feat(core): exportStream() + exportJSON() — authorization-aware export primitive](./archive/issue-72.md) · 2026-04-07

### v0.6.0

- [#73 — Issue #73 — feat(core): Query DSL .join() — eager, single FK, hash + indexed nested-loop planner](./archive/issue-73.md) · 2026-04-09
- [#74 — Issue #74 — feat(core): .join() live mode — merged change-stream subscription](./archive/issue-74.md) · 2026-04-09
- [#75 — Issue #75 — feat(core): .join() multi-FK chaining](./archive/issue-75.md) · 2026-04-09
- [#76 — Issue #76 — feat(core): Streaming join over scan() — bypass row ceiling for huge collections](./archive/issue-76.md) · 2026-04-09
- [#87 — Issue #87 — Design v0.6 query DSL & exports with partition-awareness in mind (no partition code yet)](./archive/issue-87.md) · 2026-04-09
- [#97 — Issue #97 — feat(core): aggregation reducers + .aggregate() terminal + .live() incremental](./archive/issue-97.md) · 2026-04-09
- [#98 — Issue #98 — feat(core): .groupBy(field) for query DSL aggregations](./archive/issue-98.md) · 2026-04-09
- [#99 — Issue #99 — feat(core): scan().aggregate() — memory-bounded aggregation over streaming scan](./archive/issue-99.md) · 2026-04-09
- [#100 — Issue #100 — feat(core+file): .noydb container format — magic header + opaque handle + compressed body](./archive/issue-100.md) · 2026-04-09

### v0.7.0

- [#109 — Issue #109 — feat(core): session tokens — unlock-once JWE, non-extractable WebCrypto session key, tab-scoped lifetime](./archive/issue-109.md) · 2026-04-09
- [#110 — Issue #110 — feat(core): _sync_credentials reserved collection — encrypted per-adapter OAuth token store](./archive/issue-110.md) · 2026-04-09
- [#111 — Issue #111 — feat(auth-webauthn): @noy-db/auth-webauthn — hardware-key keyring (WebAuthn + PRF + BE-flag guards)](./archive/issue-111.md) · 2026-04-09
- [#112 — Issue #112 — feat(auth-oidc): @noy-db/auth-oidc — OAuth/OIDC bridge with split-key key connector (Bitwarden-style)](./archive/issue-112.md) · 2026-04-09
- [#113 — Issue #113 — feat(auth-magic-link): magic-link unlock — one-shot read-only viewer session for client portals](./archive/issue-113.md) · 2026-04-09
- [#114 — Issue #114 — feat(core): session policies — idle/absolute timeouts, requireReAuthFor, lockOnBackground, role overrides](./archive/issue-114.md) · 2026-04-09
- [#118 — Issue #118 — feat(auth-sms): SMS OTP as explicitly weaker, second-factor-only, viewer-scoped unlock path](./archive/issue-118.md) · 2026-04-08
- [#119 — Issue #119 — feat(core): dev-mode persistent unlock — admin opt-in at setup, no biometric, heavy guardrails (dev-only)](./archive/issue-119.md) · 2026-04-09

### v0.8.0

- [#81 — Issue #81 — feat(core): dictKey schema type + reserved _dict_* collection + dictionary admin operations](./archive/issue-81.md) · 2026-04-09
- [#82 — Issue #82 — feat(core): i18nText schema type — multi-language content fields with locale fallback](./archive/issue-82.md) · 2026-04-09
- [#83 — Issue #83 — feat(core): plaintextTranslator hook — consumer-supplied translation integration point](./archive/issue-83.md) · 2026-04-09
- [#84 — Issue #84 — feat(core): exportStream() bundles dictionary snapshot for self-consistent i18n exports](./archive/issue-84.md) · 2026-04-09
- [#85 — Issue #85 — feat(core): query DSL integration for dictKey — type-enforced groupBy + locale-aware join](./archive/issue-85.md) · 2026-04-09

### v0.9.0

- [#131 — Issue #131 — feat(core): pluggable conflict policies — LWW, FWW, manual, custom merge fn](./archive/issue-131.md) · 2026-04-09
- [#132 — Issue #132 — feat(core): CRDT mode — per-collection lww-map / rga / yjs option](./archive/issue-132.md) · 2026-04-09
- [#133 — Issue #133 — feat(core): partial sync — filter by collection name or modifiedSince timestamp](./archive/issue-133.md) · 2026-04-09
- [#134 — Issue #134 — feat(core): presence and live cursors — encrypted ephemeral channel keyed by collection DEK](./archive/issue-134.md) · 2026-04-09
- [#135 — Issue #135 — feat(core): sync transactions — two-phase commit at the sync engine level](./archive/issue-135.md) · 2026-04-09
- [#136 — Issue #136 — feat(yjs): @noy-db/yjs — Yjs Y.Doc interop for rich-text fields](./archive/issue-136.md) · 2026-04-09

### none

- [#57 — Issue #57 — Refresh SVG infographics for v0.4 + new positioning](./archive/issue-57.md) · 2026-04-07
- [#152 — Issue #152 — feat(extension): @noy-db/extension-chrome — drag-and-drop .noydb reader](./archive/issue-152.md) 🟢 · 2026-04-10
- [#212 — Issue #212 — playground: comprehensive webapp — every to-*, on-*,as- and key feature in one Nuxt app](./archive/issue-212.md) 🟢 · 2026-04-21
- [#256 — Issue #256 — chore(ci): raise vitest timeouts on crypto-intensive tests — parallel workspace runs flake at 5s default](./archive/issue-256.md) · 2026-04-22


