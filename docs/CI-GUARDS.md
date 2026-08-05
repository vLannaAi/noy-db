# CI guards — the design contract, executable

Most of this project's architecture is enforced by a script rather than by
review discipline. If you are about to argue that a change is architecturally
fine, check here first: the guard either agrees with you or it does not, and it
runs on every push.

```bash
pnpm check:architecture   # scripts/check-architecture.mjs — all checks, one pass
pnpm knip                 # dead code / unused exports
```

`check:architecture` collects **every** violation before reporting, so one CI
run shows you the whole list instead of one failure at a time. Each check has a
per-file or per-package allow-list for legitimate exceptions — extend the
allow-list deliberately and with a comment, never by loosening the rule.

---

## The checks

| # | Name | What it enforces |
|---|---|---|
| 1 | `peer-deps` | Every satellite declares `peerDependencies['@noy-db/hub'] = "workspace:*"` — not `workspace:^`, and never in `dependencies`. |
| 2 | `no-crypto-deps` | Zero npm crypto packages anywhere in the workspace. `crypto.subtle` exclusively. |
| 3 | `hub-portable` | `packages/hub/src/**` imports no Node-only module. The hub must run unchanged in browsers, Workers, Bun, Deno, and Node. |
| 4 | `stores-ciphertext-only` | No `to-*` package imports a crypto primitive from `@noy-db/hub`. **This is the mechanical form of the central invariant.** |
| 5 | `strategy-opt-in` | A file that calls `createNoydb()` *and* uses a strategy-gated API (`vault.dump()`, `vault.ledger()`, `vault.dictionary()`, …) must also reference the matching `with*()` factory. |
| 5b | `every-service-gated` | Every service ships a `withX()` gate — no service reachable without opting in. |
| 5b | `service-subpath-naming` | The subpath is canonical: a service's export path, factory name, and directory agree. |
| 6 | `kernel-surface` | The three always-on orchestration files stay under a declared line ceiling. |
| 7 | `no-debug-plaintext` | No `debugPlaintext` in shipped library source. |
| 8 | `no-outbound-klum-import` | No `@noy-db` package may depend on `@klum-db`. The cross-repo dependency is one-way. |
| 9 | `port-layering` | The family ports respect their layering; the kernel spine may not depend upward on services. |
| 10 | `enclave-barrel-only` | The enclave is reached through its barrel, not by deep import. |
| 11 | `enclave-body-only` | Only `kernel/enclave/**` may read or construct the envelope's protected body fields (`_iv`, `_data`, `_cek`, `_det`, `_sealed`). |
| 12–13 | `enclave-classify-only`, `enclave-classify-index-only` | Classified-field identifier ratchets — the stage-2 and blind-index surfaces stay inside the enclave. |
| 14 | `via-layering` | The kernel spine ↔ `src/via/*` boundary holds. |
| 15 | `via-enclave-isolation` | `src/via/*` may not reach into `kernel/enclave/`. |

---

## Ratchets, and why they behave oddly

Several guards are **ratchets** rather than fixed limits. They record the
*current* number and refuse to let it grow — and in some cases refuse to let it
silently shrink either.

**`kernel-surface` (check 6).** `collection.ts`, `vault.ts`, and `noydb.ts` each
carry a line ceiling declared in `KERNEL_SURFACE_BUDGET`:

```
packages/hub/src/kernel/collection.ts   4311
packages/hub/src/kernel/vault.ts        3703
packages/hub/src/kernel/noydb.ts        2161
```

These files have repeatedly sat at **exactly** their ceiling with zero slack. If
you need to add a line to one of them, the expected move is to *shrink first* —
fold something out onto the SubsystemBus — not to raise the number. Raising a
ceiling is allowed but requires a justification comment next to it, and the
existing comments are a good model: each records what bought the increase and
why the capability could not live in a service instead.

The checker counts `split('\n').length`, which is **one more** than `wc -l`
reports on a file with a trailing newline. Budget accordingly.

**`enclave-body-only` (check 11).** `PRE_EXISTING_BODY_ACCESS` grandfathers
known call-sites per file, and the stored count must always **equal** the actual
count — in both directions. Migrating a call-site onto the barrel helpers is
therefore a two-part change: fix the code *and* decrement the map. This is
deliberate; it stops the count drifting back up under cover of an unrelated
cleanup.

---

## Guards that are not in `check:architecture`

Three gates run in CI but are **not** part of `pnpm check:architecture`, and two
of them are not in `build`, `test`, or `lint` either. They have caught real
breakage that every local gate passed.

- **`pnpm --filter @noy-db/hub bundle-check`** — the bundle-size and cross-leak
  gate (`packages/hub/scripts/check-bundle.mjs`). It resolves `@noy-db/hub`
  through the **built** `dist`, so it runs on the CI *build* job rather than the
  build-free architecture job. Adding or removing a service trips it.
- **Type reachability** (`check-type-reachability.mjs`) — every subpath must
  export the types its own signatures name. It reads the **built** `.d.ts`
  surface, which is what a consumer actually resolves, not the source. This is
  what caught `/team` failing to export its signature-named types.
- **`pnpm test:scripts`** — vitest over `scripts/`, separate from the turbo test
  run.

The general lesson: **a green `pnpm build && pnpm test && pnpm lint` does not
mean CI is green.** The dist-based checks see a different surface than source
does, and a stale `dist/` can both hide real failures and fabricate fake ones —
sourcemaps will happily present stale built code as if it were live source.

---

## CI jobs

`ci.yml` runs four jobs: `architecture` (build-free, runs `check:architecture`),
`quality` (lint + typecheck — note that this runs ESLint, so run the lint script
locally, not just typecheck), `build` (turbo build, then the two dist-based
gates above), and `test`.

`release.yml` runs a stricter verify matrix across two Node versions before
publishing.
