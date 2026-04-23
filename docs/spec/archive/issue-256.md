# Issue #256 — chore(ci): raise vitest timeouts on crypto-intensive tests — parallel workspace runs flake at 5s default

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** none
- **Labels:** type: chore, priority: medium, area: ci

---

## CI test reliability — default vitest timeouts trip under parallel workspace runs

**Symptom.** `pnpm turbo test` across the full workspace intermittently fails 1-2 tasks with "Test timed out in 5000ms" errors. The same tests pass consistently when run in isolation via `pnpm test` inside the individual package.

**Observed tests that flake:**

- `packages/hub/__tests__/attachments.test.ts > "large blob is split into multiple chunks"` — pre-existing (since v0.12.0). Encrypts ~20MB blob across multiple AES-GCM chunks.
- `packages/on-recovery/__tests__/on-recovery.test.ts > generateRecoveryCodeSet` tests — fixed 2026-04-21 in 492efbd (PBKDF2 600K iterations × 10 codes). **Fixed with explicit 30s timeouts.**

**Root cause.** Default vitest timeout is 5s. Under `pnpm turbo test` with ~49 parallel workers sharing CPU, crypto-intensive operations (PBKDF2 600K iterations, large-blob AES-GCM chunking) exhibit CPU contention that pushes them past 5s.

**Proposed fixes** (any one of):

1. **Per-test explicit timeouts** (what we did for on-recovery) — bump `testTimeout` on crypto-intensive tests to 30s. Low effort, targeted.
2. **Global default timeout bump** — set `testTimeout: 30_000` in every `vitest.config.ts`. Broad blanket solution.
3. **Reduce turbo concurrency** — `pnpm turbo test --concurrency=4` to limit parallel CPU pressure. Slows CI overall.
4. **Serial-mode for crypto tests** — tag tests with `.concurrent(false)` or run crypto packages in `pool: 'forks'` with `singleFork: true`. More complex.

**Recommendation.** Option 1 for the specific flaky attachments test (add `testTimeout: 15_000` on the "large blob" test). Option 2 as a blanket follow-up — every package's `vitest.config.ts` could set `testTimeout: 30_000` to pre-empt future flakes of the same shape. Cheap preventive measure.

**Scope-limited for v0.15.2:** the on-recovery flakes are already fixed in 492efbd. The attachments flake is pre-existing and tracked here for the next adoption-patch milestone.

**Labels**: `type: chore`, `priority: medium`
