# share-link grant-token redemption (#949) Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development.

**Goal:** Wire the frozen `#g=` grant-token grammar to the existing invite-acceptance ladder — `redeemGrantToken(parsedLink, opts)` composing `@noy-db/hub/share-link`'s `parseShareLink` output with `on-magic-link`'s `acceptInvite`, making the grammar's "single-use" claim true end-to-end. Closes #949 (milestone #46, Tier-3 wire). Pure wiring — no new crypto.

**Architecture:** `redeemGrantToken` lives in `packages/on-magic-link/src/invite.ts` (where `acceptInvite` lives; on-magic-link peer-deps hub so it can import `parseShareLink`/`ShareLink`). Body ≈ `return acceptInvite(link.grantToken, { store, newPhrase, ... })`. `acceptInvite` already does the whole safety ladder + rotation + `createNoydb` + `openVault` and returns `{ db, payload }` (a live enrolled session). All four typed errors (`InviteExpiredError`/`InviteAuditMissingError`/`InviteRevokedError`/`InviteAlreadyAcceptedError`) are inherited. Peer-recovery/rebind redeems via the same `acceptInvite` (kind is in the payload).

**Tech Stack:** TS ESM, vitest, pnpm. Package: `@noy-db/on-magic-link` (Node ≥22, ESM-only).

## Global Constraints
- Branch `feat/949-share-link-redemption` (off main). Commit per task. **NEVER add Claude/AI attribution.**
- Do NOT touch `packages/hub/src/share-link/index.ts` (frozen barrel — editing it moves `share-link-surface.golden.json`). Read `parseShareLink`/`ShareLink` from `@noy-db/hub/share-link`; add nothing to that barrel.
- `on-magic-link` has NO surface golden — adding `redeemGrantToken` + its options/result types needs no golden update, just the `src/index.ts` re-export.
- No new crypto; reuse `acceptInvite` verbatim (don't reimplement the ladder).
- Gates: `pnpm --filter @noy-db/on-magic-link test` + `pnpm --filter @noy-db/on-magic-link typecheck` + `pnpm --filter @noy-db/on-magic-link build` + `pnpm lint`. (on-magic-link tests run against PUBLISHED @noy-db/hub per the satellite law — but here we're in-repo; run the package's own vitest.)

## Locked design decisions
- **Token source:** `redeemGrantToken(link: ShareLink, opts)` reads the token from `link.grantToken`; if absent → throw a typed `GrantTokenMissingError` (new, `GRANT_TOKEN_MISSING`). (The issue sketched a separate `token` arg, but the token IS `link.grantToken` — reading it from the parsed link is the clean API; accept an optional explicit `token` override in opts only if trivially free, else omit.)
- **`newPhrase` required:** `acceptInvite` rotates the single-use temp phrase → the redeemer's chosen `newPhrase`. So `opts` MUST carry `newPhrase` (+ optional `secretPolicy`/`allowWeakSecret`/`noydbOptions`/`now` passthrough to `acceptInvite`).
- **vaultHandle vs payload.vault:** the link's `vaultHandle` is a ULID; the token's `payload.vault` is a vault NAME — different namespaces. redemption trusts the TOKEN as the capability (its audit-doc + TTL + single-use rotation are the security); the link path/handle is addressing only and is NOT cross-checked against the token's vault. Document this explicitly (a mismatched-looking path is cosmetic; the token governs).

---

### Task 1: redeemGrantToken + re-export + end-to-end tests

**Files:** `packages/on-magic-link/src/invite.ts` (add `redeemGrantToken` + `GrantTokenMissingError`), `packages/on-magic-link/src/index.ts` (re-export both + the result/options types). Test: `packages/on-magic-link/__tests__/redeem-grant-token.test.ts`.

**Interface:**
```ts
export class GrantTokenMissingError extends Error { readonly code = 'GRANT_TOKEN_MISSING'; /* ... */ }
export interface RedeemGrantTokenOptions {
  readonly store: NoydbStore
  readonly newPhrase: string
  readonly now?: Date
  readonly secretPolicy?: SecretPolicy
  readonly allowWeakSecret?: boolean
  readonly noydbOptions?: /* same passthrough acceptInvite accepts */
}
export async function redeemGrantToken(link: ShareLink, opts: RedeemGrantTokenOptions): Promise<AcceptInviteResult>
```
Body: `const token = link.grantToken; if (token === undefined) throw new GrantTokenMissingError(); return acceptInvite(token, { store: opts.store, newPhrase: opts.newPhrase, now: opts.now, secretPolicy: opts.secretPolicy, allowWeakSecret: opts.allowWeakSecret, noydbOptions: opts.noydbOptions })`. Import `ShareLink` from `@noy-db/hub/share-link`. Reuse `AcceptInviteResult` (already exported).

- [ ] **Step 1: failing tests** (mirror `invite-peer-recovery.test.ts` fixture — `inlineMemory()` store, `createNoydb({teamStrategy: withTeam(), ...})` issuer). Cases:
  - **End-to-end:** issue an invite (`issueInvite(issuer, 'acme', {userId, role})`), build a share link carrying the encoded token (`buildShareLink({ vaultHandle: <a ULID>, collection, record, grantToken: encoded })` from `@noy-db/hub/share-link`), `parseShareLink(url)`, `redeemGrantToken(link, {store, newPhrase})` → returns `{db, payload}`; assert `result.db.team.getKeyring('acme')` has the enrolled userId/role (vault open, enrolled principal).
  - **Single-use:** a SECOND `redeemGrantToken` with the same link → rejects with `InviteAlreadyAcceptedError`.
  - **Expired:** issue with a past `expiresAt` (or pass `now` in the future) → `InviteExpiredError`.
  - **Revoked:** revoke the invite's audit doc → `InviteRevokedError`.
  - **Audit-missing fail-closed:** delete the audit doc before redeem → `InviteAuditMissingError` (NOT a silent auto-create).
  - **Grant-token-missing:** a parsed link with no `#g=` (no grantToken) → `GrantTokenMissingError`.
  - **Peer-recovery/rebind:** `issuePeerRecovery` → link → redeem → assert the existing principal's DEKs preserved (`keyring.deks.size > 0`) and old phrase no longer unlocks (mirror invite-peer-recovery.test.ts:104-134).
  Assert each error is the SPECIFIC class.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** the thin composition + `GrantTokenMissingError`. Re-export from index.ts.
- [ ] **Step 4: green** + `pnpm vitest run packages/on-magic-link/__tests__/invite-peer-recovery.test.ts` (no regression) + `pnpm --filter @noy-db/on-magic-link typecheck`.
- [ ] **Step 5: commit** — `feat(on-magic-link): redeemGrantToken — wire #g= to the invite-acceptance ladder (#949)`

---

### Task 2: doc, changeset, gates

**Files:** doc (extend an existing on-magic-link or share-link doc, OR a `docs/subsystems/share-link-redemption.md` — check what exists in docs/subsystems/; the Tier-3 story may belong with the invite/tier docs), `.changeset/share-link-redemption.md`.

- [ ] **Step 1: doc** — the **Tier-3 sequence** end to end: share link (`#g=` opaque token in the fragment) → parse → `redeemGrantToken` (TTL → audit → revoke → replay ladder, rotate temp→newPhrase, open vault) → enrolled role-scoped principal → app. **Fragment hygiene:** the token rides ONLY in the URL fragment — it never reaches a server, log, or redirect; a resolver MUST read it client-side. The single-use guarantee is now true end-to-end (second redeem → typed already-accepted). Note the vaultHandle-vs-token-vault namespacing (token is the capability).
- [ ] **Step 2: changeset** `.changeset/share-link-redemption.md` (`'@noy-db/on-magic-link': minor`): `redeemGrantToken` connects the frozen `#g=` share-link grammar to the existing `acceptInvite` ladder — the missing Tier-3 wire; single-use enforced end-to-end; inherits the TTL/audit/revoke/replay typed errors; supports invite + peer-recovery redemption. (Check whether hub also needs a changeset — likely NOT, since the change is entirely in on-magic-link; confirm.)
- [ ] **Step 3: gates** — `pnpm --filter @noy-db/on-magic-link build && test && typecheck` + `pnpm lint` + `pnpm typecheck` (root, all packages, since on-magic-link is in the graph). All green.
- [ ] **Step 4: commit** — `docs(on-magic-link): Tier-3 redemption sequence + fragment hygiene + changeset (#949)`

## Out of scope
- The Studio share flow / Landing role-app surface (downstream consumers, post-pre-release).
- Any change to the frozen share-link grammar or its barrel.
