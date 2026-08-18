# #1096 Roster Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate the plaintext authority half (`role`, `permissions`, `granted_by`, capabilities, expiry) of every `_keyring` file with a vault-wide roster key, so a hostile store can no longer promote a viewer to admin by editing one word.

**Architecture:** A per-vault random 256-bit **roster key** (AES-GCM) is delivered to each member by *becoming the canary plaintext*: `KeyringFile.canary` changes from AES-KW(32 zero bytes, KEK) to AES-KW(rosterKey, KEK). A new **required** field `roster_tag: {iv, data}` holds AES-GCM(canonical(authority fields), rosterKey); `loadKeyring` decrypts it and compares against the file. A store cannot forge the tag (no roster key), cannot strip it (missing tag with a valid canary is refused), and cannot strip the canary (canary is now required — the legacy no-canary fallback is deleted per the no-legacy standing policy). Both fields become **required** in `KeyringFile` so the compiler enumerates every construction site.

**Tech Stack:** TypeScript, `crypto.subtle` via existing enclave helpers only (`wrapKey`, `unwrapKey`, `encrypt`, `decrypt`, `generateDEK` from `kernel/enclave`), vitest.

## Global Constraints

- **No legacy, no compatibility paths, no aliases** — the keyring format is replaced, not migrated (ADR 0003 Decision 5; there is no production vault).
- **No npm crypto packages; `crypto.subtle` only** (`pnpm check:architecture` enforces).
- **Hub stays portable** — no Node built-ins in `hub/src/**`.
- **Never** add Claude/Anthropic attribution to commits/PRs.
- **Never** name the private pilot client anywhere.
- Run `pnpm typecheck` and `pnpm test` from the **repo root**, never `--filter @noy-db/hub` alone. `hub`'s typecheck runs three configs; `check:types` is dist-based and manual.
- TDD; tests beside source as `*.test.ts`, adversarial harnesses in `packages/hub/__tests__/`.
- Commit style: match `git log` (`fix(hub)!:`, `test(hub):` etc. with issue refs).

## Security invariants (the spec, from two reverted attempts)

1. **Constraint 1:** admins edit authority they don't hold the target's credential for (`updateKeyringIdentity`, `rotateKeys`). ⇒ the tag key must be held by every roster **editor** — one vault-wide key, not pairwise. `update-user.test.ts` and `keyring-revocation-rollback.test.ts` are the tests that killed attempt 1; they must pass.
2. **Constraint 2:** a plaintext expectation can be deleted. ⇒ the expectation lives inside the canary (unforgeable, KEK-wrapped) and the canary is required. "Valid canary + missing/invalid tag" = refuse.
3. **The bound that must survive:** a forged/replayed role never confers a DEK it never had (test row 4 of `keyring-replay-escalation.test.ts`).
4. **Accepted residue (documented, not fixed):** every member holds the roster key, so this stops the *store* (which holds no keys — the threat model), not a malicious *member*. And a **replayed genuine file still verifies** — that is #1097, out of scope here; section B of the escalation harness continues to assert it.

---

### Task 1: Roster-tag primitives + types + error

**Files:**
- Create: `packages/hub/src/with-party/team/roster-tag.ts`
- Create: `packages/hub/src/with-party/team/roster-tag.test.ts`
- Modify: `packages/hub/src/kernel/types.ts` (KeyringFile: `canary` required, add `roster_tag` required)
- Modify: `packages/hub/src/kernel/errors.ts` (add `KeyringTamperedError`)

**Interfaces (Produces):**
```ts
// roster-tag.ts
export interface RosterTag { readonly iv: string; readonly data: string }
export type RosterAuthorityFields = Pick<KeyringFile,
  'user_id' | 'role' | 'permissions' | 'granted_by' | 'expires_at' | 'export_capability' | 'import_capability'>
export function rosterCanonical(file: RosterAuthorityFields): string
export async function mintRosterTag(file: RosterAuthorityFields, rosterKey: EnclaveKey): Promise<RosterTag>
/** false on decrypt failure OR canonical mismatch — never throws. */
export async function verifyRosterTag(file: RosterAuthorityFields, tag: RosterTag | undefined, rosterKey: EnclaveKey): Promise<boolean>
```

- [ ] **Step 1: Write the failing unit tests** (`roster-tag.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { rosterCanonical, mintRosterTag, verifyRosterTag } from './roster-tag.js'
import { generateDEK } from '../../kernel/enclave/index.js'

const base = {
  user_id: 'bob', role: 'viewer' as const,
  permissions: { invoices: 'ro' as const, salaries: 'rw' as const },
  granted_by: 'owner-01',
} // expires_at / export_capability / import_capability absent

describe('rosterCanonical', () => {
  it('is deterministic under permission key order', () => {
    const reordered = { ...base, permissions: { salaries: 'rw' as const, invoices: 'ro' as const } }
    expect(rosterCanonical(base)).toBe(rosterCanonical(reordered))
  })
  it('distinguishes absent from present optional fields', () => {
    expect(rosterCanonical(base)).not.toBe(rosterCanonical({ ...base, expires_at: '2030-01-01T00:00:00Z' }))
  })
})

describe('mint/verify', () => {
  it('round-trips', async () => {
    const key = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag(base, tag, key)).toBe(true)
  })
  it('refuses an edited role — the #1096 forgery', async () => {
    const key = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag({ ...base, role: 'admin' }, tag, key)).toBe(false)
  })
  it('refuses edited permissions, not only role', async () => {
    const key = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag({ ...base, permissions: { salaries: 'rw' } }, tag, key)).toBe(false)
  })
  it('refuses a TRANSPLANTED tag — user_id is bound', async () => {
    const key = await generateDEK()
    const adminAlice = await mintRosterTag({ ...base, user_id: 'alice', role: 'admin' }, key)
    expect(await verifyRosterTag({ ...base, role: 'admin' }, adminAlice, key)).toBe(false)
  })
  it('refuses a missing tag and a wrong key, without throwing', async () => {
    const key = await generateDEK()
    const other = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag(base, undefined, key)).toBe(false)
    expect(await verifyRosterTag(base, tag, other)).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm vitest run packages/hub/src/with-party/team/roster-tag.test.ts` → module not found)

- [ ] **Step 3: Implement `roster-tag.ts`**

```ts
/**
 * #1096 — the authenticated half of a `_keyring` file's AUTHORITY.
 *
 * A `_keyring` file is stored plaintext (`_iv: ''`) so admins can edit a
 * member's authority without holding that member's credential. That means
 * `role`/`permissions` were authenticated by NOTHING — a hostile store could
 * promote a viewer to admin by editing one word (proven in
 * `__tests__/keyring-replay-escalation.test.ts`).
 *
 * The fix is a vault-wide ROSTER KEY, delivered to each member as the canary
 * plaintext (see keyring.ts — AES-KW(rosterKey, KEK)), and a `roster_tag`:
 * AES-GCM of the canonical authority fields under that key. Every roster
 * EDITOR holds the key (constraint: admins edit authority they don't hold the
 * target's credential for), so this stops the store — which holds no keys —
 * and deliberately NOT a malicious member. SECURITY.md states the bound.
 *
 * `user_id` is inside the canonical string so a genuine tag cannot be
 * transplanted onto another member's file.
 */
import type { KeyringFile } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { encrypt, decrypt } from '../../kernel/enclave/index.js'

export interface RosterTag { readonly iv: string; readonly data: string }

export type RosterAuthorityFields = Pick<KeyringFile,
  'user_id' | 'role' | 'permissions' | 'granted_by' | 'expires_at' | 'export_capability' | 'import_capability'>

/** Stable stringify — sorts object keys recursively so key order never splits the tag. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function rosterCanonical(file: RosterAuthorityFields): string {
  return stable({
    user_id: file.user_id,
    role: file.role,
    permissions: file.permissions,
    granted_by: file.granted_by,
    expires_at: file.expires_at ?? null,
    export_capability: file.export_capability ?? null,
    import_capability: file.import_capability ?? null,
  })
}

export async function mintRosterTag(file: RosterAuthorityFields, rosterKey: EnclaveKey): Promise<RosterTag> {
  return encrypt(rosterCanonical(file), rosterKey)
}

/** false on decrypt failure OR canonical mismatch — never throws. */
export async function verifyRosterTag(
  file: RosterAuthorityFields,
  tag: RosterTag | undefined,
  rosterKey: EnclaveKey,
): Promise<boolean> {
  if (tag === undefined) return false
  try {
    return (await decrypt(tag.iv, tag.data, rosterKey)) === rosterCanonical(file)
  } catch {
    return false
  }
}
```

Note: check the actual export names in `kernel/enclave/index.ts` first (`encrypt`/`decrypt`/`EnclaveKey` — adjust imports to what the barrel actually exports; `EnclaveKey` may live in `kernel/types.ts`).

- [ ] **Step 4: Type + error changes.** In `kernel/types.ts`, on `KeyringFile`: make `canary` **required** (`readonly canary: string`) and rewrite its doc comment — it now wraps the vault **roster key** (#1096), still serving wrong-secret/corruption discrimination (AES-KW ICV), no longer optional (no-legacy policy). Add:

```ts
  /**
   * #1096 — AES-GCM({iv,data}) of the canonical authority fields
   * (user_id, role, permissions, granted_by, expires_at, capabilities)
   * under the vault roster key (delivered via `canary`). Required:
   * a valid canary with a missing or mismatching tag is refused as
   * KeyringTamperedError — absence must itself be an error, or a store
   * opts out of verification by deleting a plaintext field.
   */
  readonly roster_tag: { readonly iv: string; readonly data: string }
```

In `kernel/errors.ts`, following the file's existing class conventions (find `KeyringCorruptError` and mirror its base-class/code pattern):

```ts
/**
 * #1096 — the keyring's plaintext AUTHORITY half failed authentication.
 * Thrown by `loadKeyring` when the canary is absent, or when it unwraps
 * cleanly (KEK proven correct) but `roster_tag` is missing or does not
 * match the file. Distinct from KeyringCorruptError: the KEYS are fine;
 * the roster is what cannot be trusted.
 */
export class KeyringTamperedError extends NoydbError {
  constructor(readonly details: {
    readonly userId: string
    readonly reason: 'canary-missing' | 'roster-tag-missing' | 'roster-tag-mismatch'
  }) {
    super('KEYRING_TAMPERED',
      `Keyring for "${details.userId}" failed roster authentication (${details.reason}). ` +
      `The store serving this vault may have altered the roster.`)
  }
}
```
Export it from wherever errors are barrel-exported (grep how `KeyringCorruptError` reaches `src/index.ts` and mirror).

- [ ] **Step 5: Run unit tests — expect PASS**; run `pnpm --filter @noy-db/hub build` — expect **type errors** at every `KeyringFile` construction site (that enumeration is Task 2's worklist; do not fix them in this task). Commit only the four files: `feat(hub): roster-tag primitives + KeyringTamperedError (#1096)` — note the repo will not typecheck until Task 2 lands, so Task 1+2 may be committed together if the repo requires green commits; prefer one commit spanning both in that case.

### Task 2: The switch-on — every construction/load site

**Files (all Modify):**
- `packages/hub/src/with-party/team/keyring.ts` (UnlockedKeyring, canary section, loadKeyring, createOwnerKeyring, grant, updateKeyringIdentity, rotateKeys, changeSecret, persistKeyring, buildRecipientKeyringFile)
- `packages/hub/src/with-party/team/peer-recover.ts`, `rotate-recover.ts`
- `packages/hub/src/kernel/noydb.ts` (`createPlaintextKeyring` ~line 104)
- `packages/hub/src/with-party/session/session.ts`, `session/dev-unlock.ts`
- Any other site the compiler names (expected: pod adoption `extract-partition`/`adopt-partition`, on-password slot path — follow the type errors to zero, do not pre-enumerate)

**Interfaces (Consumes):** Task 1's `mintRosterTag`/`verifyRosterTag`/`RosterTag`/`KeyringTamperedError`.
**Produces:** `UnlockedKeyring.rosterKey: EnclaveKey | null` (required field, null only where `kek` is null or on non-tier-1 resume paths).

- [ ] **Step 1: `UnlockedKeyring`** — add after `kek`:
```ts
  /**
   * #1096 — the vault-wide roster key, unwrapped from the canary at tier-1
   * load. Null exactly where `kek` is null (plaintext mode, tier-2/3 resume,
   * session restore, dev-unlock): those paths cannot unwrap the canary and
   * also cannot persist. Any write path that stamps a roster_tag must
   * null-check, mirroring the kek guard.
   */
  readonly rosterKey: EnclaveKey | null
```

- [ ] **Step 2: canary section rewrite** (keyring.ts ~179–225). Delete `CANARY_PLAINTEXT_BYTES`/`getCanaryKey`. `mintKeyringCanary(rosterKey, kek)` becomes `wrapKey(rosterKey, kek)` (still deterministic per (KEK, rosterKey) — AES-KW fixed IV — so the "mint fresh each persist" property survives; update the comment block to say the canary now *delivers the roster key* and why that makes stripping it detectable). `verifyKeyringCanary` becomes `unwrapKeyringCanary(wrapped, kek): Promise<EnclaveKey | null>` (null on failure).

- [ ] **Step 3: `loadKeyring`** — replace the canary block:
```ts
  if (keyringFile.canary === undefined) {
    // No-legacy policy: every keyring written by this line of code carries a
    // canary. Absence means a store stripped it to escape roster verification.
    throw new KeyringTamperedError({ userId, reason: 'canary-missing' })
  }
  const rosterKey = await unwrapKeyringCanary(keyringFile.canary, kek)
```
(`canary === undefined` remains reachable at runtime despite the required type — the file is parsed from JSON a store controls.) Keep the DEK unwrap loop unchanged. Then replace the three-branch epilogue with two branches: `rosterKey !== null` → any DEK failure is `KeyringCorruptError` (as the old `canaryOk === true` branch); `rosterKey === null` → old `canaryOk === false` branch verbatim. **Delete the legacy `null` heuristic branch.** After the key checks, verify authority:
```ts
  if (!(await verifyRosterTag(keyringFile, keyringFile.roster_tag, rosterKey))) {
    throw new KeyringTamperedError({
      userId,
      reason: keyringFile.roster_tag === undefined ? 'roster-tag-missing' : 'roster-tag-mismatch',
    })
  }
```
Add `rosterKey` to the returned `UnlockedKeyring`.

- [ ] **Step 4: write sites.** Uniform recipe — every `KeyringFile` literal gains `canary: await wrapKey(<rosterKey>, <thatFileHoldersKek>)` (already present as `mintKeyringCanary` calls; just re-point the arguments) and `roster_tag: await mintRosterTag(<the file's own authority fields>, <writerRosterKey>)`, where `<writerRosterKey>` is:
  - `createOwnerKeyring`: `const rosterKey = await generateDEK()` — mint the vault's roster key here; return it on the UnlockedKeyring.
  - `grant` / `buildRecipientKeyringFile`: `callerKeyring.rosterKey` — add a null-guard throwing `ValidationError` with the same wording pattern as the existing kek guard ("cannot stamp a roster tag without the vault roster key — re-authenticate at tier 1").
  - `updateKeyringIdentity` (:1018 `next`): keep the target's `canary` (spread carries it), restamp `roster_tag: await mintRosterTag(next, callerKeyring.rosterKey)` after the null-guard.
  - `rotateKeys` (:1283 rewriting other members): same restamp with caller's rosterKey; also thread `rosterKey` through the two `persistKeyring` calls (they read it off the keyring object).
  - `persistKeyring`: guard `keyring.rosterKey` beside the kek guard; `canary: await wrapKey(keyring.rosterKey, keyring.kek)`; `roster_tag: await mintRosterTag(<the fields being written>, keyring.rosterKey)`. Build the file object first, then stamp, so the tag covers exactly what is persisted.
  - `changeSecret` (:1352): canary re-wrapped under the NEW kek (`wrapKey(keyring.rosterKey, newKek)`); restamp the tag (content unchanged, restamping is uniform and harmless).
  - `peer-recover.ts` (~:193): `canary: await wrapKey(callerKeyring.rosterKey, newKek)` — the recoverer's copy of the vault-wide key re-delivered under the fresh KEK; restamp the tag (note `granted_by` changes to the caller here, so a restamp is *required*, not optional). Null-guard callerKeyring.rosterKey.
  - `rotate-recover.ts`: after deriving `oldKek`, `const rosterKey = await unwrapKeyringCanary(file.canary, oldKek)`; if null the old secret was wrong (existing error path); re-wrap under the new KEK; restamp.
- [ ] **Step 5: keyless sites** — `createPlaintextKeyring` (noydb.ts:104), session restore (session.ts ~:139), dev-unlock (~:224): add `rosterKey: null`. Then run `pnpm --filter @noy-db/hub build` and fix every remaining compiler-named site the same way (null for resume-style paths that also carry `kek: null`; a real key everywhere a real KEK exists — if a site has a real KEK but no roster key available, stop and reconsider rather than passing null, because that would mint an unverifiable file).
- [ ] **Step 6: run the two constraint suites first** — `pnpm vitest run packages/hub/src/with-party/team/update-user.test.ts packages/hub/__tests__/keyring-revocation-rollback.test.ts` (paths approximate — locate by name). These killed attempt 1; they must PASS. Then `pnpm vitest run packages/hub` and fix fallout: expected classes are (a) fixtures asserting on the old zero-byte canary, (b) tests constructing `KeyringFile`/`UnlockedKeyring` literals, (c) tests relying on the deleted legacy no-canary fallback — those get updated to expect `KeyringTamperedError`, and any that exist purely to exercise the legacy heuristic are deleted, not preserved.
- [ ] **Step 7:** root `pnpm typecheck && pnpm test` (full repo — satellites consume `UnlockedKeyring`), `pnpm check:architecture`. Commit: `fix(hub)!: authenticate the keyring roster with a vault-wide roster key (#1096)`.

### Task 3: Flip the adversarial harness

**Files:**
- Modify: `packages/hub/__tests__/keyring-replay-escalation.test.ts`

**Consumes:** `KeyringTamperedError` (assert by name/`code`, not message).

- [ ] **Step 1: rewrite section A** as refusals. Update the header comment: section A now *asserts the defence* (the flip is the signal #1043/#1096 promised). Concretely:
  - Row 1 (plaintext fact): keep `_iv === ''` and `_data` containing `"role":"viewer"` (the file IS still plaintext — that is the design, not the bug) **and add** `expect(env._data).toContain('roster_tag')`.
  - Row 2: after `forgeRole(store, 'bob', 'admin')`, `createNoydb(...).openVault(VAULT)` **rejects with `KeyringTamperedError`** (reason `roster-tag-mismatch`). The genuine-viewer control stays.
  - Row 3 (forged revoke): same shape — the forged bob cannot even open, carol's keyring survives.
  - Row 4 (the bound): re-frame — the refusal now happens at load, *before* any read; keep a comment that the DEK-absence bound is independently pinned by roster-tag.test.ts's wrong-key row and by the grant-time wrap rules.
  - **New rows:** (5) store deletes `roster_tag` → `KeyringTamperedError('roster-tag-missing')`; (6) store deletes `canary` → `KeyringTamperedError('canary-missing')`; (7) store transplants alice's admin `roster_tag` onto bob's file → mismatch refusal; (8) store edits `permissions` (not role) → mismatch refusal.
- [ ] **Step 2: section B stays green as-is** — a replayed genuine file verifies (its roster and tag agree). Add one comment line: this is #1097, explicitly out of #1096's scope, detection via the vault head is that issue's question.
- [ ] **Step 3:** run the file; then **flip-check the guard**: temporarily comment out the `verifyRosterTag` call in `loadKeyring` and confirm rows 2/3/5/7/8 FAIL (the test is capable of failing); restore.
- [ ] **Step 4:** Commit: `test(hub): keyring roster forgery rows flip to refusals (#1096)`.

### Task 4: SECURITY.md + issue bookkeeping

**Files:**
- Modify: `SECURITY.md` (the store-boundary section)
- Modify: `docs/adr/0003-store-integrity.md` only if it references the keyring roster as unauthenticated (grep `roster`/`keyring` first)

- [ ] **Step 1:** Add to `SECURITY.md`'s boundary statement, in the same narrow-claim style the file already uses: a store cannot **edit any member's role, permissions, capabilities or expiry** (roster tag under a vault-wide key, delivered inside the canary). State the two honest bounds: (a) every member holds the roster key, so this defends against the **store**, not a malicious member forging their own file; (b) a **replayed genuine roster still verifies** — narrowing re-grants are #1097 and are documented beside the anti-entropy concession.
- [ ] **Step 2:** `pnpm lint` from root (SECURITY.md may be covered by prose checks — noy-db #1072 added fenced-import checking; make sure any code snippet added compiles against the real surface).
- [ ] **Step 3:** Commit `docs(hub): SECURITY.md — the roster is an authenticated surface (#1096)`. Open a PR for the branch (all tasks on one branch `fix/1096-roster-authentication`), body summarising: the design (canary = wrapped roster key), the two constraints from the reverted attempts and how each is honored, the accepted member-level residue, and the #1097 boundary. Do **not** close #1096 manually — `Closes #1096` in the PR body.

### Task 5: Full verification (no code)

- [ ] Root: `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm check:architecture && pnpm knip`
- [ ] By hand: `pnpm --filter @noy-db/hub check:types` (dist-based, not in the default pipeline)
- [ ] Confirm the three flake-prone parallel-load tests aren't among failures before blaming the change (#1106 context)
- [ ] Verify no diff line contains the pilot client's name: grep the full diff

---

## Amendment 1 (2026-08-17) — roster key is a reserved DEK, not the canary plaintext

Adopted after the implementer's NEEDS_CONTEXT escalation (see task-1-2-report.md): paper/Shamir
recovery derive no old KEK, so a canary-delivered roster key bricks recovered accounts, and
`buildMagicLinkKeyring` has no file to unwrap. The roster key becomes **`deks['_roster']`** — a
reserved DEK-map entry with no backing collection — so it flows through every existing DEK
channel (grant `_`-prefix propagation, `persistKeyring`, `WrappedDeksBlob` recovery,
`peer-recover`, magic-link, session tokens) with zero satellite changes.

**Supersedes in Task 1:** no `KeyringFile.canary` semantic change — it keeps wrapping the
32-zero-byte constant and KEEPS becoming required (the legacy no-canary fallback still dies).
`KeyringTamperedError` reasons become `'canary-missing' | 'roster-key-missing' |
'roster-tag-missing' | 'roster-tag-mismatch'`.

**Supersedes in Task 2:**
- Step 1 (UnlockedKeyring.rosterKey field): DROPPED. Instead export from keyring.ts:
  `export function rosterKeyOf(keyring: UnlockedKeyring): EnclaveKey | null` returning
  `keyring.deks.get(ROSTER_KEY_ID) ?? null`. Define `ROSTER_KEY_ID = '_roster'` beside
  `USER_ENVELOPE_COLLECTION` in `kernel/constants.ts`. No keyless-site edits anywhere.
- Step 2 (canary section rewrite): DROPPED — canary code unchanged.
- Step 3 (loadKeyring): keep the existing epilogue minus the legacy branch (canary absent →
  `KeyringTamperedError('canary-missing')`). AFTER the key epilogue (so wrong-secret still
  reports as InvalidKeyError, never as tampering): if `keyringFile.deks[ROSTER_KEY_ID]` is
  absent → `KeyringTamperedError('roster-key-missing')` (present-but-unwrap-failed already
  lands in the corrupt path); then verify `roster_tag` with `deks.get(ROSTER_KEY_ID)` →
  missing/mismatch errors as planned.
- Step 4 write sites: `createOwnerKeyring` mints `generateDEK()` under `ROSTER_KEY_ID`
  alongside the `_users` DEK and stamps the tag with it. All stamping sites use
  `rosterKeyOf(...)` with a null-guard mirroring the kek guard. `rotate-recover`'s three paths
  need NO roster plumbing (the blob carries `_roster`) — only tag carry/restamp per the
  existing recipe; `peer-recover` restamps (granted_by changes) with the CALLER's roster key.
  Magic-link and all `on-*` satellites: untouched.
- Step 5: only sites the compiler names via the required `roster_tag`/`canary` fields.

**Accepted and to be stated in the PR body:** every pre-change vault becomes unloadable
(`roster_tag` absent, `deks._roster` absent) with no migration — covered by the user's #1100
decision (no migration; vaults are re-seeded) and ADR 0003 Decision 5.

**Guard to add (new test row, Task 1 or 2):** `'_roster'` must not be treated as
secret-bearing (`isSecretBearingReservedCollection('_roster') === false`) so it propagates to
every role — a viewer who cannot verify the roster would be a silent hole.
