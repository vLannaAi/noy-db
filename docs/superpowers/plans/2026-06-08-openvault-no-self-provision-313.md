# `openVault` No-Self-Provision (#313) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `openVault` from silently minting an owner keyring into a vault held by other principals — create-on-open only for a genuinely-new vault (no `_keyring/*`); a missing grant on a populated vault fails closed. Add an additive `openVault({ create?: boolean })` flag.

**Architecture:** A single pre-gate in `getKeyringInternal`, placed **before `resolveManagedSecret`** (which persists on first open), keyed on one `store.list(vault,'_keyring')` membership check. Additive `create` flag threaded through `openVault` and `queryAcross`. Dedicated `0.2.0-pre.11` security release.

**Tech Stack:** TypeScript, `@noy-db/hub` core (`noydb.ts`, `types.ts`), Vitest. pnpm 9.

**Spec:** `docs/superpowers/specs/2026-06-08-openvault-no-self-provision-design.md`

**Branch:** `fix/pre11-no-self-provision` off `main` (`e7301e2`).

**Verified facts:**
- `getKeyringInternal(vault)` (`noydb.ts:2704`): `getKeyring`-callback short-circuit → `resolveManagedSecret` (managed mode; **persists `_meta/sealed-passphrase` on first open**, `team/managed-passphrase.ts:24-25`) → `loadKeyring` → catch: `NoAccessError`→`createOwnerKeyring`; `InvalidKeyError && onInvalidKey==='reset'`→reset; else throw.
- `loadKeyring` throws `NoAccessError` when `_keyring/<userId>` for the caller is absent (no other-principal check).
- `queryAcross<T>(vaultIds, fn, options)` calls `this.openVault(vaultId)` internally.
- `_shardVaultProvisioned` (`noydb.ts:1026`) already uses `(await store.list(vault,'_keyring')).length`.
- `NoAccessError` exported from `errors.js`; `encrypt:false` returns a plaintext keyring early (no create path).

Run tests: `pnpm --filter @noy-db/hub exec vitest run <file>`

---

### Task 0: blast-radius prototype (do this FIRST)

**Files:** `packages/hub/src/noydb.ts` (throwaway prototype)

- [ ] **Step 1: Prototype the gate** — in `getKeyringInternal`, immediately after the `getKeyring`-callback `if (this.options.getKeyring) {…}` block and **before** the managed-secret resolution, insert (encrypted path only):
```ts
    if (this.options.encrypt !== false) {
      const keyringUsers = await this.options.store.list(vault, '_keyring')
      if (!keyringUsers.includes(this.options.user) && keyringUsers.length > 0) {
        throw new NoAccessError(`No keyring for user "${this.options.user}" in vault "${vault}"`)
      }
    }
```
(This is the populated-by-others case only — the minimal probe to surface breakage.)

- [ ] **Step 2: Run the FULL hub suite** — `pnpm --filter @noy-db/hub test`. Record every failure. Expected: only tests that opened another principal's populated vault expecting self-provision (relying on the hole). For each, confirm it's bug-reliant (a missing `grant` before the second identity opens) — NOT a legitimate flow.

- [ ] **Step 3: Revert the prototype** (`git checkout packages/hub/src/noydb.ts`). Record the failing-test list in the commit message of Task 1 so the fixes are traceable.

If any *legitimate* flow breaks (a first-owner/fixture/migration on a genuinely-empty vault failing), STOP — the discriminator is wrong; re-evaluate. (Not expected: those have empty `_keyring/*`.)

---

### Task 1: the create flag + pre-gate

**Files:**
- Modify: `packages/hub/src/noydb.ts` (openVault opts, getKeyringInternal pre-gate + signature, queryAcross threading)
- Modify: `packages/hub/src/types.ts` (`QueryAcrossOptions.create?`)
- Test: `packages/hub/__tests__/no-self-provision.test.ts` (new)

- [ ] **Step 1: Write the failing tests.** Create `packages/hub/__tests__/no-self-provision.test.ts`. Copy the inline `memory()` adapter from `__tests__/cross-vault.test.ts`, plus a key-snapshot helper:
```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { NoAccessError } from '../src/errors.js'
// memory(): copy from cross-vault.test.ts
// also expose the underlying Map so we can snapshot keys; simplest: add a helper that lists keys via the adapter's own get/list is awkward —
// instead capture keys by wrapping put: track every (compartment, collection, id) the adapter writes.

function trackingMemory() {
  const base = memory()
  const writes: string[] = []
  return {
    adapter: {
      ...base,
      async put(c: string, col: string, id: string, env: any, ev?: number) {
        writes.push(`${c}/${col}/${id}`)
        return base.put(c, col, id, env, ev)
      },
    },
    writesSince(mark: number) { return writes.slice(mark) },
    mark() { return writes.length },
  }
}

it('default: bob opening alice\'s populated vault fails closed and writes nothing', async () => {
  const { adapter, mark, writesSince } = trackingMemory()
  const alice = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })
  const av = await alice.openVault('client-1')
  await av.collection<{ n: number }>('c').put('r1', { n: 1 })

  const bob = await createNoydb({ store: adapter, user: 'bob', secret: 'bob-pass' })
  const m = mark()
  await expect(bob.openVault('client-1')).rejects.toBeInstanceOf(NoAccessError)
  expect(writesSince(m)).toEqual([])                                 // NOTHING written
  expect(await adapter.get('client-1', '_keyring', 'bob')).toBeNull()
})

it('MANAGED mode: bob (managed) opening alice\'s vault fails closed and writes no _meta/sealed-passphrase', async () => {
  const { adapter, mark, writesSince } = trackingMemory()
  const alice = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })
  await (await alice.openVault('client-1')).collection<{ n: number }>('c').put('r1', { n: 1 })

  // a trivial in-memory sealing provider
  const provider = {
    id: 'test-kms',
    async seal(b: Uint8Array) { return { ct: Buffer.from(b).toString('base64') } },
    async unseal(s: any) { return new Uint8Array(Buffer.from(s.ct, 'base64')) },
  }
  const bob = await createNoydb({ store: adapter, user: 'bob', passphraseMode: 'managed', sealingKey: provider as any })
  const m = mark()
  await expect(bob.openVault('client-1')).rejects.toBeInstanceOf(NoAccessError)
  expect(writesSince(m)).toEqual([])                                  // no _meta/sealed-passphrase, nothing
})

it('new vault still open-or-creates (default)', async () => {
  const { adapter } = trackingMemory()
  const db = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })
  const v = await db.openVault('fresh')
  await v.collection<{ n: number }>('c').put('r1', { n: 1 })
  expect(await adapter.get('fresh', '_keyring', 'alice')).not.toBeNull()
})

it('create:false never creates, even a fresh vault', async () => {
  const { adapter } = trackingMemory()
  const db = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })
  await expect(db.openVault('fresh', { create: false })).rejects.toBeInstanceOf(NoAccessError)
  expect(await adapter.get('fresh', '_keyring', 'alice')).toBeNull()
})

it('a granted member opens fine', async () => {
  const { adapter } = trackingMemory()
  const alice = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })
  await (await alice.openVault('client-1')).collection<{ n: number }>('c').put('r1', { n: 1 })
  await alice.grant('client-1', { userId: 'bob', displayName: 'Bob', role: 'viewer', passphrase: 'bob-pass' })

  const bob = await createNoydb({ store: adapter, user: 'bob', secret: 'bob-pass' })
  const bv = await bob.openVault('client-1')
  expect(await bv.collection<{ n: number }>('c').get('r1')).toEqual({ n: 1 })
})
```
(Confirm `grant` options + the `sealingKey`/managed-mode option names against `cross-vault.test.ts` and an existing managed-mode test; adjust shapes. The behavioral asserts — fail closed + nothing written + new-vault create preserved — are fixed.)

- [ ] **Step 2: Run — fail.** `pnpm --filter @noy-db/hub exec vitest run __tests__/no-self-provision.test.ts` → the fail-closed + create:false tests fail (today bob self-provisions).

- [ ] **Step 3: Add the `create` flag + pre-gate** in `noydb.ts`.
`openVault` signature:
```ts
  async openVault(name: string, opts?: { locale?: string; create?: boolean }): Promise<Vault> {
```
Thread into the keyring load (the `const keyring = await this.getKeyringInternal(name)` call near line 421):
```ts
    const keyring = await this.getKeyringInternal(name, { create: opts?.create !== false })
```
`getKeyringInternal` signature + the pre-gate (insert right after the `if (this.options.getKeyring) {…}` block, before the managed-secret resolution):
```ts
  private async getKeyringInternal(
    vault: string,
    opts: { create: boolean } = { create: true },
  ): Promise<UnlockedKeyring> {
    // … existing: encrypt:false early return, cache check, getKeyring callback …

    // Pre-gate (#313): decide create-vs-fail BEFORE any vault write (resolveManagedSecret
    // persists on first open). One capability-free store.list; membership = caller has a keyring.
    if (this.options.encrypt !== false) {
      const keyringUsers = await this.options.store.list(vault, '_keyring')
      if (!keyringUsers.includes(this.options.user)) {
        if (opts.create === false) {
          throw new NoAccessError(`Vault "${vault}" not opened: create disabled and no keyring for "${this.options.user}".`)
        }
        if (keyringUsers.length > 0) {
          throw new NoAccessError(`No keyring for user "${this.options.user}" in vault "${vault}" (held by other principals) — refusing to self-provision.`)
        }
        // else: genuinely-new vault (no _keyring/*) → fall through to the normal mint+create path
      }
    }
    // … existing: managed-secret resolution, loadKeyring, NoAccessError→createOwnerKeyring (now only reached for the genuinely-new fall-through) …
```
Leave the `loadKeyring` catch's `NoAccessError → createOwnerKeyring` branch as-is (it now only fires for the genuinely-new case the pre-gate let through). Leave the `onInvalidKey:'reset'` branch as-is.

Add `create` to `QueryAcrossOptions` in `types.ts`:
```ts
export interface QueryAcrossOptions {
  readonly concurrency?: number
  /** Open shards non-creatingly — a missing grant throws instead of self-provisioning. Default: creating. */
  readonly create?: boolean
}
```
Thread it in `queryAcross`'s internal open (`const comp = await this.openVault(vaultId)`):
```ts
        const comp = await this.openVault(vaultId, { create: options.create !== false })
```

- [ ] **Step 4: Run — pass.** The 5 tests green. Then `pnpm --filter @noy-db/hub test` (full suite) — fix any bug-reliant tests surfaced (add the missing `grant` before the second identity opens; this is the correct pattern). `pnpm --filter @noy-db/hub run typecheck` clean.

- [ ] **Step 5: Commit.**
```bash
git add packages/hub/src/noydb.ts packages/hub/src/types.ts packages/hub/__tests__/no-self-provision.test.ts
git commit -m "fix(hub): openVault no longer self-provisions into a vault held by other principals (#313)

Pre-gate in getKeyringInternal (before resolveManagedSecret) fails closed when the caller has no
keyring and the vault has other principals' keyrings; create-on-open only for a genuinely-new vault
(no _keyring/*). Additive openVault({create?}) + queryAcross({create?}). Tests assert nothing is
written on the fail-closed path (default + managed mode)."
```
(If Task 0 surfaced bug-reliant tests, list them + their grant-fixes in the body.)

---

### Task 2: pre.11 lockstep bump + SECURITY changelog

**Files:**
- Modify: `packages/hub/CHANGELOG.md`
- Modify: all 66 `packages/*/package.json` (version field)

- [ ] **Step 1: CHANGELOG SECURITY entry** — prepend under `# Changelog — hub`:
```markdown
## 0.2.0-pre.11

### Security: `openVault` no longer self-provisions into another principal's vault ([#313](https://github.com/vLannaAi/noy-db/issues/313))

- Opening a vault you hold **no grant** to that is **already held by other principals** now fails closed with `NoAccessError` and writes **nothing** — previously it silently minted a fresh owner keyring (new DEKs) into that vault and read zero records. Genuinely-new vaults (no `_keyring/*`) still open-or-create as before.
- New opt-in **`openVault({ create: false })`** (and `queryAcross({ create: false })`) forces strict open-existing — a missing grant throws instead of creating.
- The fix sits **before** managed-passphrase secret resolution, so managed mode (KMS-sealed) also writes nothing on the fail-closed path.
```

- [ ] **Step 2: Lockstep bump** all package versions `0.2.0-pre.10` → `0.2.0-pre.11`:
```bash
for f in packages/*/package.json; do perl -i -pe 's/"version": "0\.2\.0-pre\.10"/"version": "0.2.0-pre.11"/ if $. < 10' "$f"; done
grep -rl '"version": "0.2.0-pre.11"' packages/*/package.json | wc -l    # expect 66
grep -rl '"version": "0.2.0-pre.10"' packages/*/package.json || echo "all bumped"
```

- [ ] **Step 3: Verify** — `pnpm --filter @noy-db/hub run typecheck`, `pnpm --filter @noy-db/hub test`, `node scripts/validate-features.mjs`, `node scripts/check-architecture.mjs` → all green/clean.

- [ ] **Step 4: Commit.**
```bash
git add -A
git commit -m "release: 0.2.0-pre.11 — security: openVault no-self-provision (#313)"
```

---

## Self-review notes
- **Spec coverage:** pre-gate before resolveManagedSecret (Task 1 Step 3); managed-mode no-write test (Task 1 Step 1 #2); create flag + queryAcross threading (Task 1); new-vault preserved + create:false + granted-member (Task 1); blast-radius step-0 (Task 0); release (Task 2).
- **Membership check:** `keyringUsers.includes(this.options.user)` — if the caller IS a member, fall through (loadKeyring loads their keyring); the pre-gate only acts when the caller is absent. Correct: a granted member never trips it.
- **`getKeyring` callback path / `onInvalidKey:'reset'` / plaintext:** untouched (pre-gate is after the callback short-circuit and gated on `encrypt !== false`; reset is the caller's own stale keyring).
- **Federation interaction:** after this lands, the cross-vault A/B work consumes the `create` flag (`create:false` on the read fan-out/`openShard`) — re-confirm it's belt-and-suspenders vs load-bearing when trimming that plan's Task 2.
