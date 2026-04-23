# Issue #113 — feat(auth-magic-link): magic-link unlock — one-shot read-only viewer session for client portals

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, area: core

---

## Summary

Add **magic-link unlock** — a flow where a user clicks a one-time link from their email and gets a **read-only, viewer-scoped** session on a compartment, without ever typing a passphrase. The viewer KEK is derived from a server-issued ephemeral secret combined with a device-local secret, in the same split-key family as the OIDC bridge.

This is the mechanism for **client portals**: an accounting firm sends a link to a client, the client clicks it, reads their invoices, closes the tab, and the session is gone. No passphrase to forget, no OAuth to set up, no hardware key to issue.

## Motivation

The project's primary consumer is a platform where firm staff work with clients who are **not technical**. Asking a retiree to install a PWA and enroll a WebAuthn credential is not going to happen. Asking them to type a passphrase is a support-ticket generator. The lowest-friction path that still preserves zero-knowledge is:

1. Staff member grants the client a viewer role in the compartment.
2. System emails the client a link: `https://portal.example.com/open?t=...`
3. Client clicks, sees their invoices, closes the tab.
4. The same link does not work twice, and it expires after N minutes.

This is the pattern that Substack uses for sign-in, 1Password uses for emergency kits, and Bitwarden uses for Emergency Access. It's well-understood and the UX is genuinely lower-friction than any alternative.

## Why this is a security issue, not just a UX issue

Magic links look easy to implement badly. Common mistakes, each of which destroys the property they exist to protect:

- **Link-in-URL token is the KEK itself** → the email, the email server, the user's browser history, and any URL-logging proxy all leak the key.
- **Link authenticates a session cookie on a server that holds the plaintext** → the server becomes part of the trust boundary, which defeats zero-knowledge.
- **Link is reusable** → phishing resistance drops to zero, and stolen emails are replayable forever.
- **Viewer KEK is the same as the owner KEK** → a leaked link is a full-access breach, not a read-only breach.

This proposal avoids all four by deriving a **separate, viewer-scoped KEK** that cannot decrypt writer-scoped records, held via a split between server and device, with one-shot consumption.

## Proposed design

### Viewer-scoped KEK

The v0.4 keyring already supports per-role DEKs (viewer role gets `*: ro` permission). Magic-link unlock extends this: when an owner or admin grants a client a viewer role, the system derives a **viewer-specific KEK** that can only unwrap the DEKs marked as viewer-readable. A leaked viewer KEK cannot touch writer-scoped records.

This is a precondition for magic-link being safe at all. Without it, "send them a link" is "send them the keys to the kingdom."

### Three-party one-shot split

Parties:

1. **Client** (the human about to click the link)
2. **Magic-link server** (small service the consumer deploys, holds pending tokens + wrapped fragments)
3. **Compartment owner's session** (the party that originally issued the invite)

Flow:

```
ISSUE (owner is unlocked, inviting a client)
────────────────────────────────────────────

1. Owner grants the client a viewer role in the keyring. Client gets a
   viewer-scoped KEK — viewer_kek.

2. Owner generates:
   - token_secret   (32 bytes random, lives in the magic-link URL)
   - server_fragment (derived from viewer_kek + token_secret)

   server_fragment = HKDF(viewer_kek, salt=token_secret, info="noydb/magic/v1")
   device_secret    = viewer_kek XOR server_fragment
   # device_secret is NOT stored on any device yet — it travels in the URL

3. Owner computes invite_id = SHA256(token_secret).
   Owner sends to magic-link server: { invite_id, server_fragment, expires_at,
   max_uses: 1 }. Server stores it indexed by invite_id.

4. Owner sends the email link:
   https://portal.example.com/open?t=<base64(token_secret)>#<base64(device_secret)>

   Note the # — device_secret is in the URL FRAGMENT, which browsers do not
   send to the server as part of the request line. The magic-link server
   only ever sees token_secret in the query string, never device_secret.


REDEEM (client clicks the link)
───────────────────────────────

1. Client loads portal.example.com/open?t=...#... in a browser.
2. JS on the page reads token_secret from query, device_secret from hash.
3. JS POSTs invite_id = SHA256(token_secret) to the magic-link server.
4. Server looks up { server_fragment, expires_at, used_count }:
   - If expired → reject
   - If used_count >= max_uses → reject
   - Else → return server_fragment, increment used_count
5. Client reconstructs viewer_kek = server_fragment XOR device_secret.
6. Client downloads the compartment bundle (via whatever adapter is configured).
7. Client unlocks with viewer_kek → read-only session.
8. On tab close, session is gone. No persistent state.
```

**Why this resists each of the common attacks:**

- **Email is stolen / logged** → attacker has both `token_secret` and `device_secret` (from the URL fragment). This IS a successful attack on this specific invite. Mitigations: short expiry (default 15 minutes), single-use (max_uses=1), viewer-only scope (blast radius limited to read-only access).
- **Server is compromised** → attacker has `server_fragment` but not `device_secret` (it never hit the server). Still needs to steal the email to combine them.
- **Server logs leak query strings** → attacker has `token_secret` but not `device_secret` (fragments aren't logged in standard access logs). Same combination problem.
- **Man-in-the-middle on HTTPS** → HTTPS does protect URL fragments in transit (they are part of the encrypted URL). Not a new attack surface.
- **Client runs JS and the attacker injects into the portal page** → this is the main real threat. The portal page is the trust boundary. CSP, SRI, and locked-down dependencies are the defenses, same as any other web app.

### Rate-limiting and replay defenses

The magic-link server MUST:

- Rate-limit invite redemption by IP (e.g. 10/minute/IP)
- Rate-limit invite redemption by invite_id (exactly 1 successful redemption ever)
- Record every redemption attempt for audit
- Delete `server_fragment` from its store after successful redemption (not just increment the counter — actually delete it, so a later DB dump doesn't include used fragments)

### API surface

```ts
import { issueMagicLink, openMagicLink } from '@noy-db/auth-magic-link'

// Owner side — after granting the client a viewer role
const invite = await issueMagicLink(db, {
  compartment: 'acme',
  grantedBy: 'vlanna',            // current owner/admin session
  grantedTo: 'client-bob',         // viewer role already created
  viewerScope: ['invoices', 'payments'],  // collections visible
  expiresInMs: 15 * 60 * 1000,    // 15 minutes
  magicLinkServer: 'https://portal.example.com/magic',
})

// invite.url → send this via email (through whatever email delivery the consumer uses)
// invite.expiresAt → display in the UI as "this invite expires at ..."


// Client side — runs on the portal page when the link is clicked
const session = await openMagicLink(db, {
  compartment: 'acme',
  urlToken: window.location.search,   // "?t=..."
  urlFragment: window.location.hash,  // "#..."
  magicLinkServer: 'https://portal.example.com/magic',
})
// → read-only NoydbSession, expires on tab close
```

### Package shape

```
packages/auth-magic-link/
├── src/
│   ├── index.ts
│   ├── issue.ts        # owner-side: generate split, register with server
│   ├── redeem.ts       # client-side: fetch fragment, reconstruct KEK
│   └── errors.ts
└── reference-server/
    ├── server.ts       # ~150-line reference implementation
    └── README.md
```

Depends on `@noy-db/core` (session + viewer-scoped KEK) and `@noy-db/auth-oidc` (shares the split-key helper).

## Acceptance criteria

- [ ] **Viewer-scoped KEK must exist as a separate primitive.** A leaked magic link MUST NOT grant write access or access to collections outside the viewer's scope. Covered by negative test.
- [ ] **`device_secret` is delivered via URL fragment, not query string.** Covered by test that mocks a request logger and asserts `device_secret` never appears in server-side request logs.
- [ ] **`invite_id` is `SHA256(token_secret)`**, not the token itself. The server never stores the token in plaintext. Covered by test.
- [ ] **Redemption is strictly one-shot.** A successful redeem deletes the fragment from the store; a second attempt with the same token returns `MagicLinkAlreadyUsedError`. Covered by test.
- [ ] **Expired invites return `MagicLinkExpiredError`** and are garbage-collected from the store within 1 minute of expiry. Covered by test.
- [ ] **Session produced by magic-link unlock is read-only.** Attempting a write operation must throw `ReadOnlySessionError`. Covered by test.
- [ ] **Session expires on tab close**, independently of the absolute timeout. `pagehide` destroys the session synchronously.
- [ ] **Reference server validates origin** — only accepts redemption POSTs from the configured portal origin.
- [ ] **No plaintext KEK ever hits the magic-link server.** Asserted by inspecting the server's request handlers in tests.

## Email OTP delivery variant (added per discussion #117)

Email OTP is a structurally similar alternative to the URL-based magic link for users who can't reliably click links (screen readers, very old email clients, paste-rather-than-click workflows). It ships as a **delivery variant** of the same split-key machinery, with explicit documentation that it is **strictly weaker** than the URL variant.

**Why weaker**: the URL variant puts `device_secret` in the URL fragment (`#...`), which browsers do not send to servers or log. Email OTP has no fragment — the 6-to-8-digit code IS the full token. Anyone who sees the email has everything needed to redeem it. Email forwarding, inbox compromise, and shared devices all become plausible attack vectors.

**Shape**:

```ts
await issueMagicLink(db, {
  compartment: 'acme',
  grantedBy: 'vlanna',
  grantedTo: 'client-bob',
  delivery: 'email-otp',              // vs 'email-link' (default)
  expiresInMs: 2 * 60 * 1000,         // 2m default for OTP, 15m for link
  maxAttempts: 3,                     // per code — tighter than link
  magicLinkServer: 'https://portal.example.com/magic',
})
// → returns { code: '483921', expiresAt: ... }
// → consumer delivers "Your code is 483921" via whatever email transport
```

**Additional constraints for the OTP variant** (beyond the link variant):

- [ ] **TTL hard-capped at 5 minutes** even if policy tries to extend (vs 24h for link variant). Default 2 minutes.
- [ ] **Max 3 redemption attempts per code**, then the code is burned.
- [ ] **Device binding**: the code can only be redeemed from the same browser origin that requested it (verified via a scoped localStorage token issued at request time). Prevents pure email-replay attacks from a different device.
- [ ] **Viewer-scope only** — OTP codes cannot unlock write access under any configuration.
- [ ] **UI displays a clear warning** when the OTP variant is selected vs the link variant: "Email codes are convenient but weaker than magic links. Prefer links when possible."
- [ ] **Rate limiting**: 5 code requests per recipient per hour on the reference server.
- [ ] **The `delivery: 'email-otp'` path shares the same underlying `kek_fragment` storage** as the link variant. Only the client-side redemption UX differs.

**Not the default.** Consumers opt into email OTP per invite. The default `delivery` is `'email-link'`.

## Open questions

1. **Email delivery.** Should we ship an email sender? No — consumers have their own (SES, Postmark, etc.). The library returns a URL; the consumer sends the email.
2. **Custom TTL per invite.** Probably configurable, with a hard ceiling (e.g. 24 hours max). Nobody should be issuing week-long magic links.
3. **Multi-use invites.** "Here's a link for your team, first 5 who click get access." Probably yes, with `max_uses: N`, but each successful redemption still deletes one unit of the fragment and regenerates a fresh split for the remaining.
4. **Device-bound extension.** After clicking once, offer the user the option to "remember this device" by storing a fresh device secret in a WebAuthn PRF credential. Turns the one-shot magic link into a recurring device-bound unlock. Nice UX, adds scope.
5. **Audit trail.** Every issue and redemption is a ledger entry in the owner's compartment, right? Yes — makes "who accessed my records, when" queryable after the fact.

## Non-goals

- Login for owners/admins. Magic link is strictly for read-only viewer access.
- Long-lived sessions via magic link. Tab close = session death. No refresh tokens.
- Push notifications. Email only in v1 (link or OTP code).
- SMS delivery. SMS OTP is tracked in a separate issue (see #118) because the security tradeoffs warrant isolated discussion and separate acceptance criteria.
- Marketing emails dressed up as magic links. The URL format must be recognizable as a security-sensitive link, not a newsletter.

## Dependencies

Blocked by:
- Session-tokens issue (sessions must exist)
- `_sync_credentials` not required (magic-link doesn't use OAuth tokens)
- Viewer-scoped KEK primitive — if this isn't already possible with v0.4 keyrings, file a sub-issue

Shares infrastructure with:
- `@noy-db/auth-oidc` (split-key helper, reference server deployment patterns)
