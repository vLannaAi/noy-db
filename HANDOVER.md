# Session handover

> **Purpose:** context for the next session. Start fresh — older session
> notes have been retired. Historical ship decisions live in
> [`docs/spec/`](./docs/spec/INDEX.md).

**Current state:** v0.21 epoch opening. Foundation epoch closed with
56 packages shipped, four prefix families populated
(`to-*` / `in-*` / `on-*` / `as-*`), GitHub pruned to active Fork
lanes only.

---

## Quick orientation

- **README.md** — why noy-db + 30-second vanilla example + family catalog.
- **docs/packages/{stores,integrations,auth,exports}.md** — per-family
  catalogs. Lead with distinctive packages, then essentials.
- **docs/spec/INDEX.md** — the *why* behind every shipped feature.
  `grep docs/spec/archive/` for issue bodies, `grep docs/spec/prs/`
  for merge rationale.
- **ROADMAP.md** — v0.21 forward + the four Fork lanes.
- **SPEC.md** — design invariants. Do not violate without discussion.
- **CLAUDE.md** — coding conventions + architecture summary for AI
  pair-programming.

---

## Common commands

```bash
# Install + build everything
pnpm install
pnpm turbo build

# Test one package or all
pnpm --filter @noy-db/hub test
pnpm turbo test

# Interactive CLI tour (no cloud / network)
pnpm demo

# End-to-end showcases (14 pass locally; 1 needs DynamoDB creds)
pnpm --filter @noy-db/showcases test

# Lint + typecheck pipeline
pnpm turbo lint typecheck

# Full verify (what CI runs)
pnpm turbo build lint typecheck test
```

---

## Release (paused until publish strategy is agreed)

```bash
pnpm release:version
git add . && git commit -m "chore: release vX.Y.Z"
git push origin main && git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
pnpm turbo build && pnpm changeset publish
```

---

## Showcase #10 — cloud DynamoDB (manual run)

```bash
aws cloudformation deploy \
  --template-file showcases/cfn-showcase-table.yaml \
  --stack-name noydb-showcase

NOYDB_SHOWCASE_DYNAMO=1 pnpm --filter @noy-db/showcases test -- 10-cloud-dynamo

aws cloudformation delete-stack --stack-name noydb-showcase
```

The CFN template uses `PAY_PER_REQUEST` billing + `DeletionPolicy: Delete`
so the table costs $0 idle and tearing the stack down tears the data
down too.

---

## ESLint rules that bite

| Rule | What it requires |
|---|---|
| `@typescript-eslint/no-unused-vars` | Prefix unused vars with `_` |
| `@typescript-eslint/no-explicit-any` | Use `unknown` instead of `any` |
| `@typescript-eslint/no-non-null-assertion` | Avoid `!` — narrow the type |
| `@typescript-eslint/no-unnecessary-type-assertion` | Don't cast when already narrowed |
| `@typescript-eslint/no-base-to-string` | Don't `String(unknownValue)` — narrow first |
| `@typescript-eslint/unbound-method` | Wrap method references in arrow functions |
| `@typescript-eslint/await-thenable` | Don't `await` a sync function's result |
| `no-control-regex` | No literal control chars in regex — scan char codes instead |
| `import/no-cycle` | No circular imports |

---

## Package-family quick reference

| Prefix | Count | Where to look |
|---|---:|---|
| `@noy-db/to-*` | 20 | [`docs/packages/stores.md`](./docs/packages/stores.md) |
| `@noy-db/in-*` | 10 | [`docs/packages/integrations.md`](./docs/packages/integrations.md) |
| `@noy-db/on-*` | 9 | [`docs/packages/auth.md`](./docs/packages/auth.md) |
| `@noy-db/as-*` | 9 | [`docs/packages/exports.md`](./docs/packages/exports.md) |
| hub + tooling | 8 | `@noy-db/hub`, `@noy-db/p2p`, `@noy-db/cli`, `create-noy-db`, `@noy-db/to-meter`, `@noy-db/to-probe` |

---

## When writing a new package

1. Copy the nearest sibling's `package.json` / `tsup.config.ts` /
   `tsconfig.json` / `vitest.config.ts` as a starting point.
2. Follow the family's pattern:
   - `to-*`: 6-method `NoydbStore` interface, `casAtomic` capability flag.
   - `in-*`: accept framework as peer-dep, expose reactive primitives.
   - `on-*`: crypto primitives only; caller coordinates storage + audit.
   - `as-*`: `toString` + `download` + `write` shape with `acknowledgeRisks`
     on disk-write; audit-ledger entry via `vault.assertCanExport()`.
3. Mock external services in tests — CI must pass without AWS / Drive /
   sshd / Postgres / anything real. Look at `to-aws-s3`, `to-postgres`,
   `to-ssh`, or `to-drive` for the duck-typed-client pattern.
4. File the issue (or re-open it) in the matching Fork milestone.
5. `closes #N, closes #M` in the commit — separator commas are required
   for multi-close triggers.

---

## Open questions for v0.21

- npm publish coordination — still paused; strategy TBD.
- Scaffolder / playground priority — adopters want the comprehensive
  Nuxt playground; tradeoff against core work.
- Which remaining Fork items are actually wanted in production vs
  positioning-only (to-qr, to-stego are the obvious niche ones).
