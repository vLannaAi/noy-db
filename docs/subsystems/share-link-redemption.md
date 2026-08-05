# Share-link redemption — the Tier-3 wire

The share-link grammar (`@noy-db/hub/share-link`) is a frozen, golden-tested contract seam:
`[base]/r/{vaultHandle}/{collection}/{record}[?period=…][?v=…][#g=…]`. It has always had
producers (`buildShareLink`) and parsers (`parseShareLink`), and it has always declared the
optional fragment token single-use (`share-link.ts:114-116`) — but until `redeemGrantToken`
(#949) it had **zero consumers**: nothing took a parsed `#g=` token and turned it into an
enrolled session. This page documents the completed Tier-3 story: a share link a recipient
opens on a phone, with no installed software, ends up as a role-scoped principal inside the
app — and the single-use claim is now true end to end.

## The sequence: link → entry → role → app

```
issueInvite(issuer, vault, {...})           (on-magic-link, issuer side)
  → IssueInviteResult { payload, encoded }
buildShareLink({ vaultHandle, collection, recordId, grantToken: encoded })   (hub/share-link)
  → "https://.../r/{ULID}/invoices/r1#g=<encoded>"
                    │
                    │  (link travels — email, chat, QR code; the fragment
                    │   never leaves the client that reads it)
                    ▼
parseShareLink(url)                          (hub/share-link, recipient side)
  → ShareLink { vaultHandle, collection, recordId, grantToken }
redeemGrantToken(link, { store, newPhrase }) (on-magic-link, recipient side)
  → runs acceptInvite's full ladder:
      TTL check → audit-doc-missing fail-closed → revoked → already-accepted (replay)
    → rotates the single-use temp phrase to `newPhrase`
    → createNoydb + openVault
  → AcceptInviteResult { db, payload }        an enrolled, role-scoped principal
                    │
                    ▼
        the role app (db.team.getKeyring(vault).role drives what the UI shows)
```

`redeemGrantToken` (`packages/on-magic-link/src/invite.ts`) is pure composition — it reads
`link.grantToken`, and if present, calls `acceptInvite(token, opts)` verbatim. No new crypto,
no new safety ladder: every check `acceptInvite` already enforced (TTL first, then the
audit-doc-missing fail-closed defense, then revoked, then already-accepted) runs exactly as
before. What #949 adds is the missing wire between the frozen link grammar and that ladder —
before this, an application had to hand-decode the fragment and call `acceptInvite` itself;
now `parseShareLink` → `redeemGrantToken` is the whole recipient-side flow.

## Single-use is now true end to end

The share-link grammar has always *called* `#g=` a "single-use grant token," but nothing
enforced that claim before a redemption path existed — the token was inert data with no
consumer to burn it. `redeemGrantToken` closes that gap by inheriting `acceptInvite`'s
existing single-use mechanics unchanged:

1. The temp phrase inside the token is rotated to the redeemer's `newPhrase` — the temp phrase
   no longer unlocks anything after the first successful redemption.
2. The invite's audit doc is stamped `acceptedAt` on success.

A **second** `redeemGrantToken` call against the same link throws `InviteAlreadyAcceptedError`
— not a silent no-op, not a fresh session, a typed rejection. This is now verified by an
end-to-end test (`packages/on-magic-link/__tests__/redeem-grant-token.test.ts`): issue → build
link → parse → redeem once (succeeds) → redeem again with the same link (rejects).

## Fragment hygiene — why `#g=` is the only safe place for this token

The grant token rides **only** in the URL fragment (`#g=<token>`), never in the path or query
string. This is a load-bearing security property, not a style choice:

- Browsers and HTTP clients **never send the fragment to the server** — it is stripped before
  the request line is built. A single-use capability token that reached the server would show
  up in access logs, reverse-proxy logs, and any CDN in front of the origin, all of which
  typically retain logs far longer than the token's TTL.
- It never appears in an HTTP redirect's `Location` header (redirects operate on the
  request path/query the server sees — which excludes the fragment).
- It never gets forwarded transparently the way a query parameter can be when a page issues
  its own subsequent requests without stripping it first.

The consequence for implementers: **a resolver must read `#g=` client-side only.** Server-side
routing (which vault, which collection, which record) can and should use the path/query — those
segments are frozen, ULID-validated, and safe to log. The moment any part of the redemption flow
tries to read the grant token from `req.url` on a server, or forwards the full URL (fragment
included) to another origin, the single-use capability has been leaked to a channel it was
designed to avoid. `@noy-db/hub/share-link`'s own module doc states the same rule for
`parseShareLink`/`buildShareLink`; this page states it again from the redemption side because
it's the step where a careless integration (e.g. a server-rendered redirect that echoes the
full incoming URL, fragment included, into a `Location` header) could reintroduce the leak.

## The four typed failures + one more

`redeemGrantToken` throws whatever `acceptInvite` throws — no new error class is introduced for
the ladder itself:

| Error | `code` | When |
|---|---|---|
| `InviteExpiredError` | `INVITE_EXPIRED` | `now` is past the invite's `expiresAt`. Checked *first*, before any store read. |
| `InviteAuditMissingError` | `INVITE_AUDIT_MISSING` | No audit doc found for the token's `tokenId`. Fails closed — this is the revoked-link-shadow-keyring defense from #32: a missing audit doc must never fall through to `createNoydb`'s no-keyring auto-create path. |
| `InviteRevokedError` | `INVITE_REVOKED` | The audit doc's `revokedAt` is set (`revokeInvite` was called). |
| `InviteAlreadyAcceptedError` | `INVITE_ALREADY_ACCEPTED` | The audit doc's `acceptedAt` is already set — the replay case that makes single-use real. |

`redeemGrantToken` adds exactly one new failure, for a case `acceptInvite` never had to
consider because it always received a token directly:

| Error | `code` | When |
|---|---|---|
| `GrantTokenMissingError` | `GRANT_TOKEN_MISSING` | The parsed `ShareLink` has no `grantToken` — e.g. a link built without a `#g=` fragment (a bare record-addressing link, not a share/invite link). |

## Invite vs. peer-recovery redemption

The same link shape and the same `redeemGrantToken` call redeem both invite kinds — `kind`
lives inside the decoded payload, not in the call site:

- **Invite** (`issueInvite`): mints a **new** user via `db.grant`. Redemption via
  `redeemGrantToken` returns an `AcceptInviteResult` whose `db` is a fresh session for a
  principal that didn't exist before.
- **Peer-recovery** (`issuePeerRecovery`): rewraps an **existing** principal's DEKs under a new
  secret via `db.team.recoverUser`, for a user who lost their credential but is still enrolled.
  Redemption is the identical call — `redeemGrantToken(link, { store, newPhrase })` — because
  `acceptInvite` branches on `payload.kind` internally, not the caller.

Both paths share every safety-ladder check and the single-use guarantee above; the difference is
entirely in what `issueInvite`/`issuePeerRecovery` did on the issuer side before the link was
ever built.

## `vaultHandle` vs. `payload.vault` — two different namespaces

A parsed `ShareLink`'s `vaultHandle` is a ULID (the path address the link was served from).
The decoded token's `payload.vault` is a vault **name** — a different namespace entirely, chosen
by the issuer when they called `issueInvite`/`issuePeerRecovery`. `redeemGrantToken` does **not**
cross-check the two. This is deliberate: the token is the capability. Its own audit-doc
presence, TTL, and single-use rotation are the security boundary — not the path segment the
link happened to be served under. A `vaultHandle` that looks like it doesn't match
`payload.vault` is cosmetic, not a security signal; treating it as one would be checking the
wrong thing while the actual capability check (the token ladder above) already ran.

## See also

- `packages/hub/src/share-link/share-link.ts` — the frozen link grammar (`parseShareLink` /
  `buildShareLink`), including the fragment transport rule this page restates from the
  redemption side.
- `packages/on-magic-link/src/invite.ts` — `issueInvite` / `issuePeerRecovery` / `acceptInvite` /
  `redeemGrantToken` and the four-plus-one typed errors.
- `packages/on-magic-link/__tests__/redeem-grant-token.test.ts` — the end-to-end, single-use,
  expired, revoked, audit-missing, grant-token-missing, and peer-recovery redemption cases.
- Issue #949 — the work this subsystem shipped under.
