# Session handover

> **Purpose:** context for the next Claude Code session. Read this first —
> it will save you 10 minutes of re-discovery.
>
> **Updated:** 2026-04-09 — v0.9.0 released and post-release cleanup complete.

---

## What this project is

NOYDB is a zero-knowledge, offline-first, encrypted document store with
pluggable backends and multi-user access control. TypeScript monorepo,
Node 18+ and modern browsers. See `SPEC.md` for the full design reference;
`CLAUDE.md` for coding conventions.

**Privacy rule (CLAUDE.md):** never name the first consumer (an accounting
firm). Use "accounting firm", "first consumer", or "the platform". Grep for
the actual name before any commit or publish that touches user-facing copy.

---

## Current state: v0.9.0 released — repo clean

```
main  35226e1  docs: v0.9.0 post-release cleanup — HANDOVER
```

Working tree clean. All 13 `@noy-db/*` packages at **0.9.0** on npm.
GitHub release: https://github.com/vLannaAi/noy-db/releases/tag/v0.9.0

**1132 tests passing** — 772 core + 11 yjs + 18 auth-webauthn + 21 auth-oidc + 310 other packages.

No open PRs. No open v0.9 issues. Milestone v0.9.0 closed.
Open milestones: v0.10.0, v0.11.0.

---

## What v0.9 added (already shipped — do not re-implement)

| # | Module | What it does |
|---|--------|--------------|
| #131 | `core/collection.ts` | `conflictPolicy: 'last-writer-wins' \| 'first-writer-wins' \| 'manual' \| fn`. Manual mode emits `sync:conflict` with `resolve` callback. Custom fn: decrypt→merge→re-encrypt. |
| #132 | `core/crdt.ts` | `crdt: 'lww-map' \| 'rga' \| 'yjs'` per-collection. `collection.getRaw(id)` returns `CrdtState`. `mergeCrdtStates`, `resolveCrdtSnapshot`, `buildLwwMapState`, `buildRgaState`. |
| #133 | `core/sync.ts` | `push(comp, { collections })`, `pull(comp, { collections, modifiedSince })`, `sync(comp, { push, pull })`. Adapter may add `listSince?()` for server-side filtering. |
| #134 | `core/presence.ts` | `collection.presence<P>()` → `PresenceHandle<P>`. HKDF-derived presence key from DEK. Pub/sub + storage-poll fallback at `_presence_COLLECTION`. |
| #135 | `core/sync.ts` | `db.transaction(comp).put(col, id, rec).delete(col, id).commit()`. Two-phase local write + filtered push. |
| #136 | `packages/yjs/` | New `@noy-db/yjs` package. `yjsCollection(comp, name, { yFields })`, `getYDoc/putYDoc/applyUpdate`, `yText/yMap/yArray` descriptors. |

**Key implementation notes (don't rediscover these):**
- **CRDT state** stored encrypted in `_data` (not the resolved snapshot). `get()` auto-resolves via `decryptRecord` — checks `'_crdt' in parsed`. `getRaw()` returns raw `CrdtState`. CRDT conflict resolver registered with SyncEngine via `onRegisterConflictResolver`.
- **RGA tombstones**: tombstoned items stay in `items` array (for cross-device ordering); `tombstones` is the NID filter list. `resolveCrdtSnapshot` filters them.
- **Presence key** = `HKDF(DEK, salt='noydb-presence', info=collectionName)` — see `crypto.ts:derivePresenceKey`. Presence records in `_presence_COLLECTION` on sync adapter for cross-device polling.
- **`@noy-db/yjs`** stores `base64(Y.encodeStateAsUpdate)` as the `crdt: 'yjs'` payload. Core's conflict resolver for `crdt: 'yjs'` falls back to LWW (higher `_v`); proper `Y.mergeUpdates` is caller's responsibility via `applyUpdate`.
- **`encryptJsonString(json, version)`** — low-level helper in Collection; both normal and CRDT paths call it. Same for `decryptJsonString`.
- **ESLint gotcha from v0.9 lint failure**: don't use inline `import()` type annotations (`import('./types.js').Foo`) — import the type at the top of the file. Also, `typeof x === 'object'` narrows `unknown` to `object` — `as object` cast after that is flagged as unnecessary.

---

## What v0.8 added (already shipped — do not re-implement)

| Issue | Module | What it does |
|-------|--------|--------------|
| #81 | `core/dictionary.ts` | `dictKey(name, keys?)` descriptor + `DictionaryHandle` CRUD + `_dict_*` reserved collections |
| #82 | `core/i18n.ts` | `i18nText({ languages, required, autoTranslate? })` descriptor, `validateI18nTextValue`, `resolveI18nText`, `applyI18nLocale`, per-locale `get`/`list` |
| #83 | `core/noydb.ts` | `plaintextTranslator` hook — auto-translate missing locales before `put()`, in-process cache, `db.translatorAuditLog()` |
| #84 | `core/compartment.ts` | `exportStream()` / `exportJSON()` attach dictionary snapshots, captured atomically before first yield |
| #85 | `core/query/builder.ts`, `groupby.ts`, `join.ts` | `query().join(dictKeyField)` attaches labels, `groupBy().aggregate().runAsync({ locale })` adds `<field>Label` |

**Key implementation notes (don't rediscover these):**
- `DictionaryHandle` takes `encrypted: boolean` — respects `encrypt: false` for test environments
- Dict-join detection uses `!= null` not `!== undefined` — `resolveDictSource()` returns `null` for non-dictKey fields
- Export snapshots built upfront before any `yield` to survive concurrent mutations mid-stream
- `DictionaryHandle._syncCache` is a write-through Map that enables O(1) sync snapshots for the query executor

---

## Next: v0.10 planning

No issues filed yet for v0.10. See `ROADMAP.md` for planned scope:
- `noydb` CLI (`init`, `open`, `dump`, `load`, `codegen`, `migrate`, `verify`)
- Browser DevTools panel
- VSCode extension
- Importers (`@noy-db/import-postgres`, `import-sqlite`, `import-csv`, `import-firebase`, `import-mongo`)
- Type generation (`noydb codegen`)
- Test utilities (`@noy-db/testing`: `createTestDb()`, `seed()`, `snapshot()`, time-travel mocks)

**Partition-awareness seams (#87)** are dormant in the query layer — every `JoinLeg` carries `partitionScope: 'all'` and every reducer factory accepts `{ seed }`. Do not remove either — load-bearing for v0.10.

---

## Release-time invariants (hard-won — do not skip)

### 1. Always use `pnpm release:version`
Never run `pnpm changeset version` directly. The custom script in
`scripts/release.mjs` normalises all `@noy-db/*` packages to core's
canonical version, preventing changeset's pre-1.0 heuristic from
computing stray `1.0.0` bumps. This has burned us twice.

### 2. Peer deps must be `workspace:*` not `workspace:^`
All adapter and auth packages use `"@noy-db/core": "workspace:*"` in
`peerDependencies`. `workspace:^` triggers the changeset major-bump
heuristic. Do not revert.

### 3. New packages need lockfile updates before CI
When a new workspace package is added, run `pnpm install` locally,
commit the updated lockfile, and push it on the feature branch.
CI runs `--frozen-lockfile` and fails immediately without it.

### 4. Auth branches must rebase onto core branch, not main
When new core barrel exports are added in the same release, auth package
branches must be rebased onto the core feature branch — not main — so
those exports are visible during CI. Rebase onto main only after core merges.

### 5. happy-dom WebCrypto is occasionally flaky in CI
The `auth-oidc` round-trip DEK test intermittently fails with
`Cipher job failed`. It passes locally every time — just re-run the CI job.

### 6. PR merge order matters
Merge core PR first. After it lands on main, rebase auth PRs onto
updated main before merging them. `gh pr merge --merge --delete-branch`
is safe; never force-push main.

---

## Build commands

```bash
pnpm install                      # install all workspace deps
pnpm turbo build                  # build all packages
pnpm turbo test                   # run all tests
pnpm turbo lint                   # lint all packages (ESLint)
pnpm turbo typecheck              # typecheck all packages
pnpm vitest run packages/core     # run core tests only
pnpm vitest run -t "session"      # run tests matching pattern

# Release (when ready)
pnpm release:version              # bump all packages to core's version
grep -r '1\.0\.0' packages/*/package.json  # sanity check for stray 1.0.0
git add . && git commit -m "chore: release vX.Y.Z"
git push origin main
# wait for CI green
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
pnpm turbo build                  # build before publish
pnpm changeset publish            # publish to npm
```

---

## ESLint rules that have bitten us

These rules cause CI failures if you miss them. Watch for them in new files:

| Rule | What it requires |
|------|-----------------|
| `@typescript-eslint/no-unused-vars` | Prefix intentionally unused vars with `_` |
| `@typescript-eslint/no-explicit-any` | Use `unknown` instead of `any` |
| `@typescript-eslint/no-non-null-assertion` | Avoid `!` — narrow the type instead |
| `@typescript-eslint/no-unnecessary-type-assertion` | Don't cast when the type is already narrowed (e.g. `as object` after `typeof x === 'object'`) |
| `import/no-cycle` | No circular imports — use structural typing or callbacks |
| `no-restricted-syntax` (inline import) | No `import()` type references inline — import the type at the top of the file |
