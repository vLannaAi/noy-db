# @noy-db/showcases

> End-to-end feature demonstrations for noy-db. Each showcase is a vitest
> test file that doubles as a **runnable demo**, an **assertion-based test**,
> and a **reference tutorial**. They live outside `packages/` because they
> aren't published to npm — they're living documentation.

## What a showcase proves

Every showcase exercises a specific combination of:

- **one or more stores** (`to-memory`, `to-file`, `to-aws-dynamo`, ...)
- **one framework surface** (`hub` directly, `in-pinia`, `in-vue`, `in-nuxt`, `in-yjs`)
- **one topology pattern** (see [`docs/topologies.md`](../docs/topologies.md))

The matrix document is the map; showcases are the proof a particular cell
actually works.

## Running the showcases

```bash
# From repo root — memory and framework showcases only (no cloud required)
pnpm --filter @noy-db/showcases test

# Watch mode while iterating
pnpm --filter @noy-db/showcases test:watch

# Typecheck the showcases package
pnpm --filter @noy-db/showcases typecheck
```

Memory and framework showcases complete in under 5 seconds. Cloud showcases
(`#10 Cloud DynamoDB`, `#11 AWS Split Store`) are **skipped unless
`NOYDB_SHOWCASE_AWS_PROFILE` is set** — see the next section.

## The fourteen showcases

| # | File | Framework | Store | Pattern | GitHub issue |
|---|------|-----------|-------|---------|:-:|
| 01 | `01-accounting-day.showcase.test.ts`    | Pinia      | `memory()`                    | Local only              | [#166](https://github.com/vLannaAi/noy-db/issues/166) |
| 02 | `02-multi-user-access.showcase.test.ts` | Node       | `memory()`                    | Local only              | [#167](https://github.com/vLannaAi/noy-db/issues/167) |
| 03 | `03-store-routing.showcase.test.ts`     | Node       | `routeStore(memory × 2)`      | Records + cold + tenant | [#168](https://github.com/vLannaAi/noy-db/issues/168) |
| 04 | `04-sync-two-offices.showcase.test.ts`  | Vue        | `memory() × 3`                | Offline + peer sync     | [#169](https://github.com/vLannaAi/noy-db/issues/169) |
| 05 | `05-blob-lifecycle.showcase.test.ts`    | Node       | `memory()`                    | Blob/attachment         | [#170](https://github.com/vLannaAi/noy-db/issues/170) |
| 06 | `06-cascade-delete-fk.showcase.test.ts` | Nuxt+Pinia | `memory()`                    | Local + FK integrity    | [#171](https://github.com/vLannaAi/noy-db/issues/171) |
| 07 | `07-query-analytics.showcase.test.ts`   | Pinia      | `memory()`                    | Local + analytics       | [#172](https://github.com/vLannaAi/noy-db/issues/172) |
| 08 | `08-resilient-middleware.showcase.test.ts` | Node    | `wrapStore(flaky, ...)`       | Production hardening    | [#173](https://github.com/vLannaAi/noy-db/issues/173) |
| 09 | `09-encrypted-crdt.showcase.test.ts`    | Yjs        | `memory()`                    | CRDT collaboration      | [#174](https://github.com/vLannaAi/noy-db/issues/174) |
| 10 | `10-cloud-dynamo.showcase.test.ts`      | Nuxt       | `dynamo()` (real AWS)         | Cloud sync              | [#175](https://github.com/vLannaAi/noy-db/issues/175) |
| 11 | `11-aws-split-store.showcase.test.ts`   | Node       | `routeStore(dynamo + s3)`     | Records + blobs split   | — (new 2026-04-21) |
| 12 | `12-oidc-bridge.showcase.test.ts`       | Pure hub   | `memory()` + fetch mock       | Authentication (OIDC)   | — (new 2026-04-21) |
| 13 | `13-webauthn.showcase.test.ts`          | Pure hub   | `memory()` + navigator stub   | Authentication (WebAuthn) | — (new 2026-04-21) |
| 14 | `14-dictionary-i18n.showcase.test.ts`   | Pure hub   | `memory()` + `vault.dictionary()` | i18n — EN/TH/AR multi-locale | — (new 2026-04-21) |

### Related interactive demos (not in the CI suite)

Some auth flows require a real browser / real identity provider; those
live as pages in the Nuxt playground so they can drive real
`navigator.credentials` and real OIDC redirects:

- **`/webauthn`** — real biometric / passkey enrol + unlock via
  `@noy-db/on-webauthn`. Run with `pnpm --filter @noy-db/playground-nuxt dev`.
- **`/oidc`** — configurable multi-provider login (Google, Apple, LINE,
  Meta, Auth0, Keycloak). Set client IDs in `playground/nuxt/.env`;
  see [`docs/integrations-oidc.md`](../docs/integrations-oidc.md) for per-provider
  setup walkthroughs.

## Cloud showcases — profile-based AWS auth

Cloud showcases resolve AWS credentials + region from a named profile in
your local `~/.aws/credentials` / `~/.aws/config`. Nothing is read from
the environment or hard-coded. If the profile variable is absent, every
cloud showcase skips cleanly — memory and framework showcases still run.

### Step 1 — point at your profile

Copy `showcases/.env.example` to `showcases/.env` and fill in:

```bash
cp showcases/.env.example showcases/.env
# then edit showcases/.env:
#   NOYDB_SHOWCASE_AWS_PROFILE=<your-profile-name>
```

`showcases/.env` is gitignored (matches the root `.gitignore` `.env` glob).
Only the template file is committed.

### Step 2 — deploy the CFN stack

The CFN template at `showcases/cfn-showcase-table.yaml` provisions both
resources the cloud showcases need — a DynamoDB table and an S3 bucket —
in a single stack.

```bash
aws cloudformation deploy \
  --template-file showcases/cfn-showcase-table.yaml \
  --stack-name noydb-showcase \
  --profile <your-profile-name>
```

Costs: DynamoDB `PAY_PER_REQUEST` (→ $0 when idle), S3 empty bucket (→ $0
idle). The S3 bucket has a **1-day object lifecycle rule** as a safety
net: if an afterAll cleanup ever fails, S3 auto-purges test blobs within
24 hours, so forgotten objects never accrue cost.

### Step 3 — run the cloud showcases

```bash
# Run everything, including both cloud showcases (they pick up the
# profile + region from your .env automatically)
pnpm --filter @noy-db/showcases test

# Or just one cloud showcase
pnpm --filter @noy-db/showcases test -- 11-aws-split-store
```

### Step 4 — cleanup

**Per-test cleanup** runs automatically in each showcase's `afterAll`. It
deletes every record and blob chunk the test wrote. Toggle via `.env`:

```
NOYDB_SHOWCASE_AWS_CLEANUP=1    # default — delete after each run
NOYDB_SHOWCASE_AWS_CLEANUP=0    # leave records for inspection
```

**Stack teardown** is always manual:

```bash
aws cloudformation delete-stack \
  --stack-name noydb-showcase \
  --profile <your-profile-name>
```

The stack's DeletionPolicy is `Delete` on both resources, so this
removes the DynamoDB table and the S3 bucket (including any remaining
objects).

### Multiple concurrent test environments

Each test run generates a unique vault-name suffix
(`showcase-NN-<timestamp>-<rand>`), so concurrent CI invocations against
the same AWS account never collide. Override the resource names if you
want to run multiple CFN stacks side-by-side:

```
# .env
NOYDB_SHOWCASE_DYNAMO_TABLE=my-team-noydb-showcase
NOYDB_SHOWCASE_S3_BUCKET=my-team-noydb-showcase-blobs
```

## Conventions

Every showcase file follows the same shape:

1. **Header comment** — one-line summary, link to GitHub issue, matrix pattern(s) exercised.
2. **`describe(...)` block** named `Showcase NN — Title (Framework)`.
3. **`beforeEach` / `afterEach`** (memory) or **`beforeAll` / `afterAll`** (cloud) to open/close the `Noydb` instance.
4. **A sequence of `it(...)` blocks** walking through the demo steps; each step has a one-line subtitle comment explaining *what* it proves.
5. **Final `it('step N — recap: ...', ...)`** that ties the showcase's claim back to a concrete assertion — often a ciphertext peek or a convergence check.

Shared fixtures live in `src/_fixtures.ts`. Shared AWS wiring lives in
`src/_aws.ts`. Showcase-local helpers stay in the same file to keep
each demo self-contained.

## Design rule

> A showcase should be readable top-to-bottom as a tutorial, then still run
> cleanly as a CI test. If one of those breaks, we fix it — never suppress
> one for the other.
