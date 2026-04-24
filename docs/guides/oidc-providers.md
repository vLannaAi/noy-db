# OIDC Provider Setup for the NOYDB Playground

> The Nuxt playground at `playground/nuxt/app/pages/oidc.vue` renders one
> "Login with X" button per OIDC provider whose client ID is present in
> `runtimeConfig.public`. This document is the step-by-step companion:
> how to register an application with each provider, which redirect URI
> and scopes to configure, and which env vars the playground reads.
>
> All providers redirect to `http://localhost:3000/oidc` during local
> development. This is the exact path of the playground page — do not
> change it per-provider or PKCE state handoff breaks.
>
> Every provider in this document has been validated against the
> playground's PKCE flow at v0.12. If a dashboard moves a button, the
> URL pattern and field names still apply — prefer those over the exact
> click path.

---

## Which provider should I pick?

A short decision tree. The provider you pick for the playground is a
demo choice, not a production choice — NOYDB treats them all the same
downstream because the split-key unlock only needs a valid `id_token`.

- **Want zero setup, offline, Docker OK?** → [Keycloak](#keycloak). One
  `docker run` command, works without internet, ideal for CI.
- **Want a real popular provider in 5 minutes?** → [Google](#google) or
  [LINE](#line). Both have a free tier, no domain verification, and
  ship `id_token` on the first try.
- **Want a universal bridge to all providers via one SDK?** →
  [Auth0](#auth0). Configure Google/Apple/Meta/LINE as upstream
  connections inside Auth0 and NOYDB sees a single OIDC surface.
- **Target iOS users?** → [Apple](#apple). Required by App Store review
  if you offer any third-party social login.
- **Already have a Facebook audience?** → [Meta](#meta--facebook), with
  the caveats in that section — Meta's web flow is OAuth2-first, not
  OIDC-first, and needs an opt-in to emit a compliant `id_token`.

The playground is compatible with any combination — enabled providers
render as buttons side by side.

---

## Google

Easiest provider. Works on a personal Gmail account, no domain
verification required for localhost.

### Prerequisites

- Google account (personal Gmail is fine).
- A Google Cloud project. Create one at
  <https://console.cloud.google.com/projectcreate> — name it
  `noydb-playground` or similar.

### Create the OAuth client

1. Open <https://console.cloud.google.com/apis/credentials>.
2. Click **Create Credentials → OAuth client ID**.
3. If prompted to configure the OAuth consent screen first, pick
   **External**, set User Type, fill only the required fields
   (app name, support email), and add your own email as a test user.
4. Back on the Credentials page, choose **Application type:
   Web application**.
5. **Name:** `NOYDB Playground`
6. **Authorised JavaScript origins:** `http://localhost:3000`
7. **Authorised redirect URIs:** `http://localhost:3000/oidc`
8. Click **Create**. Copy the **Client ID** — you do not need the
   client secret for the PKCE flow.

### Endpoints

- Authorization: `https://accounts.google.com/o/oauth2/v2/auth`
- Token: `https://oauth2.googleapis.com/token`
- JWKS: `https://www.googleapis.com/oauth2/v3/certs`
- Discovery: `https://accounts.google.com/.well-known/openid-configuration`

### Scopes

`openid email profile` — `openid` is required for the `id_token`;
`email` and `profile` populate the claims the playground displays.

### Env vars

```bash
# playground/nuxt/.env
NUXT_PUBLIC_OIDC_GOOGLE_CLIENT_ID=xxxxxxxxxxxx-yyyyyy.apps.googleusercontent.com
```

### Test identities

Use your own Google account. If you need a second identity, add another
Google account as a test user under **OAuth consent screen → Test
users**. Up to 100 test users free, no billing required.

### Caveats

- Test users only work while the app is in **Testing** mode. Moving to
  **Production** requires Google verification (only matters for
  non-localhost deployments).
- Google rotates JWKS keys silently. The playground re-fetches on every
  unlock so this is not an issue locally.

---

## Apple

Required for iOS App Store review if your app offers any social login.
Free tier requires an Apple Developer account — **this is
$99/year** and there is no way around it for a Services ID, despite
what some older guides claim.

### Prerequisites

- Apple Developer account: <https://developer.apple.com/programs/>.
- A Mac or access to one (the entitlements console needs Safari
  occasionally — Chrome works for the main console).

### Create the Services ID

Apple separates App IDs (native) from Services IDs (web). For the
playground we need a Services ID.

1. Open <https://developer.apple.com/account/resources/identifiers/list>.
2. Click **+** → **Services IDs** → **Continue**.
3. **Description:** `NOYDB Playground`
4. **Identifier:** `dev.noydb.playground` (must be a reverse-domain
   string you own — `dev.` prefix works for localhost).
5. Register. Then click into the Services ID and enable **Sign in with
   Apple**.
6. Click **Configure** next to Sign in with Apple.
7. **Primary App ID:** create an App ID first if you don't have one
   (Identifiers → + → App IDs). Any App ID works.
8. **Domains and Subdomains:** leave blank for localhost (Apple rejects
   `localhost` here — this is documented and expected).
9. **Return URLs:** `http://localhost:3000/oidc`
10. Save, Continue, Register.

### Create the signing key

Apple requires the client to sign a JWT as the client secret.

1. Open <https://developer.apple.com/account/resources/authkeys/list>.
2. Click **+**, name it `NOYDB Playground Key`.
3. Check **Sign in with Apple**, click **Configure**, pick the Primary
   App ID from above, Save.
4. Register and **download the `.p8` file immediately** — Apple will
   not let you re-download it.
5. Note the **Key ID** (shown on the key detail page) and your **Team
   ID** (top-right of the developer portal).

The key connector server handles the actual JWT minting; the
playground only uses the Services ID.

### Endpoints

- Authorization: `https://appleid.apple.com/auth/authorize`
- Token: `https://appleid.apple.com/auth/token`
- JWKS: `https://appleid.apple.com/auth/keys`
- Discovery: `https://appleid.apple.com/.well-known/openid-configuration`

### Scopes

`openid email name` — Apple returns `email` and `name` **only on the
first login per user**. Store them immediately or they are gone.

### Env vars

```bash
NUXT_PUBLIC_OIDC_APPLE_CLIENT_ID=dev.noydb.playground
```

(The client ID for Apple is the Services ID, not the App ID.)

### Test identities

Use your own Apple ID or create a test Apple ID at
<https://appleid.apple.com/account>. Apple does not offer synthetic
test users — every identity is a real Apple ID.

### Caveats

- **Services ID, not App ID.** This trips up every first-time
  integrator. The App ID is for iOS app binaries; the Services ID is
  for web.
- **localhost redirect is allowed**, but Apple rejects `localhost` in
  the **Domains** field. Leave it empty and only fill Return URLs.
- Apple's `id_token` uses `form_post` response mode by default — the
  playground handles this, but if you write your own flow remember
  that the token arrives as a POST body, not a query string.
- Email may be a relay address (`xxx@privaterelay.appleid.com`). This
  is still a stable `sub`, so NOYDB split-key unlock works fine.

---

## LINE

Very popular in Thailand, Japan, and Taiwan. Free developer account,
setup faster than Google (no consent-screen wizard).

### Prerequisites

- LINE account (the messaging app account — one phone number, one
  account).
- LINE Developers console: <https://developers.line.biz/console/>.

### Create the channel

LINE calls its OAuth clients "channels". The one that emits OIDC
`id_token`s is the **LINE Login** channel.

1. Sign in to <https://developers.line.biz/console/>.
2. Create a provider if you have none (the provider is the namespace
   for channels — e.g. `NOYDB Dev`).
3. Click the provider, then **Create a new channel → LINE Login**.
4. **Region:** Japan works globally; pick closest.
5. **Channel name:** `NOYDB Playground`
6. **Channel description:** free text.
7. **App types:** check **Web app** (also check Native app if you plan
   to reuse for mobile).
8. **Email address:** your email. Complete the form.
9. After creation, open the **LINE Login** tab and set the **Callback
   URL** to `http://localhost:3000/oidc`.
10. On the **Basic settings** tab, copy the **Channel ID** — this is
    the `clientId` for OIDC.

### Endpoints

- Authorization: `https://access.line.me/oauth2/v2.1/authorize`
- Token: `https://api.line.me/oauth2/v2.1/token`
- JWKS: `https://api.line.me/oauth2/v2.1/certs`
- Discovery: `https://access.line.me/.well-known/openid-configuration`

### Scopes

`openid profile email` — `email` requires a separate opt-in step on
the **OpenID Connect** tab ("Apply for email permission"). Approval is
automatic for developer-mode apps.

### Env vars

```bash
NUXT_PUBLIC_OIDC_LINE_CHANNEL_ID=1234567890
```

Yes, `CHANNEL_ID` not `CLIENT_ID` — LINE's field name is "Channel ID"
and the playground code mirrors this to reduce confusion when debugging
against LINE docs.

### Test identities

Your own LINE account, or create a second LINE account with a
different phone number. LINE does not offer synthetic test users and
disallows one account per email.

### Caveats

- LINE Login channels are **different from Messaging API channels** —
  the latter does not emit OIDC tokens.
- Email scope requires manual "Apply for email permission" on the
  OpenID Connect tab. Without it, the `id_token` omits `email`.
- LINE does not support public clients without a client secret — the
  token endpoint requires basic auth with the channel secret. The
  playground uses PKCE and sends the secret, which works; a pure SPA
  would need a backend shim.

---

## Meta / Facebook

**Caveat up front:** Meta's standard web Login is OAuth2-first, not
OIDC-first. The default `/dialog/oauth` flow emits an `access_token`,
not an `id_token`. To get an `id_token` you must:

1. Request the `openid` scope explicitly.
2. Use the **Limited Login** flow (which is officially iOS-only) OR
3. Rely on the `response_type=id_token` variant that Meta
   ships inconsistently across SDK versions.

For the playground this means Meta works, but the `id_token` has
fewer claims than Google/Apple/LINE, and certain Meta app types (older
Classic apps) will not emit one at all. **If you need a reliable
social-login demo, use Google or LINE instead.** If you must show Meta
integration, continue below.

### Prerequisites

- Facebook account.
- Meta for Developers: <https://developers.facebook.com/>.

### Create the app

1. Open <https://developers.facebook.com/apps/>.
2. Click **Create App**.
3. **Use case:** pick **Authenticate and request data from users with
   Facebook Login** — this is the one that routes you to the OIDC-
   capable app type.
4. **App type:** **Consumer** (Business type does not expose the OIDC
   toggles).
5. **App name:** `NOYDB Playground`
6. After creation, open **Products → Facebook Login → Settings** (add
   the product if it is not on the side bar).
7. **Valid OAuth Redirect URIs:** `http://localhost:3000/oidc`
8. **Login with the JavaScript SDK:** No (the playground uses its own
   PKCE).
9. From **App settings → Basic**, copy the **App ID**.

### Endpoints

- Authorization: `https://www.facebook.com/v18.0/dialog/oauth`
- Token: `https://graph.facebook.com/v18.0/oauth/access_token`
- JWKS: `https://www.facebook.com/.well-known/oauth/openid/jwks/`

Meta does not publish a single discovery document — it is scattered
across Login, Graph, and Limited Login docs. Pin the version in the
path (`v18.0` as of this writing) or behaviour changes silently.

### Scopes

`openid email public_profile` — `openid` is the one that flips Meta
from OAuth2 to OIDC mode.

### Env vars

```bash
NUXT_PUBLIC_OIDC_META_CLIENT_ID=1234567890123456
```

The env var says `CLIENT_ID` because that is the OIDC term; Meta's
dashboard calls it "App ID".

### Test identities

Meta offers **Test Users** under **Roles → Test Users**. Create 2-3,
each gets a disposable `@tfbnw.net` email and cannot post to real
users' feeds. Perfect for the playground.

### Caveats

- **`id_token` is not guaranteed.** Depending on your app's
  configuration and Meta's A/B testing, the token endpoint may return
  only an `access_token`. The playground falls back to `/me?fields=id`
  in that case, but the split-key flow prefers `id_token`.
- **App review required for production.** Localhost is exempt but
  anything on a real domain needs App Review for `email` scope.
- **Data Deletion URL and Privacy Policy URL** are required even for
  dev apps before the first login — set them to
  `http://localhost:3000/privacy` to unblock local testing; they are
  not actually fetched during dev.
- Facebook's `sub` claim is the app-scoped User ID, **not** the global
  Facebook ID — it is stable per app, so NOYDB enrollment still works,
  but you cannot cross-reference it with other Facebook services.

---

## Auth0

Useful as a single upstream for Google, Apple, Meta, LINE, Microsoft,
GitHub, SAML, LDAP — NOYDB sees one OIDC issuer regardless of which
upstream the user picks. Free tier is 7,500 monthly active users.

### Prerequisites

- Auth0 account: <https://auth0.com/signup>.
- Auth0 "tenant" (created automatically on signup; name it e.g.
  `noydb-dev`).

### Create the application

1. Open <https://manage.auth0.com/dashboard/>.
2. **Applications → Applications → + Create Application**.
3. **Name:** `NOYDB Playground`
4. **Type:** **Single Page Web Applications** (this preselects PKCE
   and disables client secret, which matches the playground).
5. Create. Open the **Settings** tab.
6. **Allowed Callback URLs:** `http://localhost:3000/oidc`
7. **Allowed Web Origins:** `http://localhost:3000`
8. **Allowed Logout URLs:** `http://localhost:3000`
9. Scroll down, **Save Changes**.
10. Copy the **Domain** (e.g. `noydb-dev.us.auth0.com`) and **Client
    ID** from the top of Settings.

### (Optional) Add upstream connections

1. **Authentication → Social**. Toggle Google, Apple, Facebook, LINE —
   each has a built-in adapter that takes the upstream's client ID and
   secret. Auth0 normalises the `id_token` shape so NOYDB sees the
   same claims regardless of provider.
2. For each upstream enabled, make sure your new Application is listed
   under the **Applications** tab of the connection.

### Endpoints

Every Auth0 tenant exposes `.well-known/openid-configuration`:

- Discovery: `https://YOUR-TENANT.us.auth0.com/.well-known/openid-configuration`
- Authorization: `https://YOUR-TENANT.us.auth0.com/authorize`
- Token: `https://YOUR-TENANT.us.auth0.com/oauth/token`
- JWKS: `https://YOUR-TENANT.us.auth0.com/.well-known/jwks.json`

### Scopes

`openid email profile` — Auth0 always returns a well-formed `id_token`
for SPA applications.

### Env vars

```bash
NUXT_PUBLIC_OIDC_AUTH0_DOMAIN=noydb-dev.us.auth0.com
NUXT_PUBLIC_OIDC_AUTH0_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Test identities

**User Management → Users → + Create User**. Pick the
`Username-Password-Authentication` connection. Create 2-3 users with
test emails — Auth0 lets you set passwords directly.

### Caveats

- **Free-tier rate limit:** 1000 logins per minute, 7,500 MAU. More
  than enough for the playground; a real deployment on the free tier
  will notice the limit.
- **US vs EU vs AU tenants** — the domain contains the region
  (`.us.auth0.com`, `.eu.auth0.com`, `.au.auth0.com`). The env var
  name `DOMAIN` includes the region — do not strip it.
- **Upstream providers still require their own developer accounts.**
  Enabling "Sign in with Apple" in Auth0 redirects the Services ID
  config back to Apple — Auth0 is a bridge, not a shortcut around
  provider-side registration.

---

## Keycloak

Best choice for offline development and CI. Self-hosted, free, open
source, no account to sign up for, no rate limits.

### Prerequisites

- Docker installed.
- Port 8080 free on localhost.

### Start Keycloak

One command, starts in ~10 seconds:

```bash
docker run --rm -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest \
  start-dev
```

Open <http://localhost:8080/> and sign in with `admin` / `admin`.

### Create the realm and client

1. Top-left realm dropdown → **Create realm**. Name it `noydb`. Create.
2. Left sidebar → **Clients → Create client**.
3. **Client type:** OpenID Connect. **Client ID:** `noydb-playground`.
   Next.
4. **Client authentication:** OFF (public client — PKCE only).
5. **Standard flow:** ON. **Direct access grants:** OFF. Next.
6. **Valid redirect URIs:** `http://localhost:3000/oidc`
7. **Web origins:** `http://localhost:3000`
8. Save.

### Endpoints

All under the realm issuer `http://localhost:8080/realms/noydb`:

- Discovery: `http://localhost:8080/realms/noydb/.well-known/openid-configuration`
- Authorization: `http://localhost:8080/realms/noydb/protocol/openid-connect/auth`
- Token: `http://localhost:8080/realms/noydb/protocol/openid-connect/token`
- JWKS: `http://localhost:8080/realms/noydb/protocol/openid-connect/certs`

### Scopes

`openid email profile` — Keycloak ships all three by default.

### Env vars

```bash
NUXT_PUBLIC_OIDC_KEYCLOAK_ISSUER=http://localhost:8080/realms/noydb
NUXT_PUBLIC_OIDC_KEYCLOAK_CLIENT_ID=noydb-playground
```

### Test identities

Create users via the admin UI:

1. Left sidebar → **Users → Add user**.
2. Username: `alice`. Email, first/last name optional. Create.
3. Open the user → **Credentials** tab → **Set password**. Un-check
   "Temporary" to avoid the first-login password-change prompt.
4. Repeat for `bob`, `charlie`.

For scripted setup, `kcadm.sh` inside the container works:

```bash
docker exec -it <container> \
  /opt/keycloak/bin/kcadm.sh create users \
  -r noydb -s username=alice -s enabled=true
```

### Caveats

- **Default admin is `admin` / `admin`** on the dev image — do not
  expose this container to the internet.
- **`start-dev` disables HTTPS and in-memory persistence.** Restarting
  the container loses all realms, users, and credentials. For CI this
  is fine; for longer-lived local use, mount a volume to
  `/opt/keycloak/data`.
- **Issuer URL strictness:** Keycloak's `iss` claim exactly matches
  the configured hostname. If the browser uses `http://localhost:8080`
  but the playground is served from `http://127.0.0.1:3000`, token
  validation fails because Keycloak's issuer is `localhost`, not
  `127.0.0.1`. Keep both at `localhost`.

---

## How the playground page uses this

The page at `playground/nuxt/app/pages/oidc.vue` reads all client IDs
from `runtimeConfig.public.oidc*` (which Nuxt wires automatically from
env vars prefixed with `NUXT_PUBLIC_OIDC_`). At render time:

1. The page iterates the known provider list and keeps only the ones
   whose client ID env var is present and non-empty. **No client ID
   set → no button rendered.** There is no "disabled" state.
2. Clicking a button generates a fresh PKCE `code_verifier` + SHA256
   `code_challenge`, stores the verifier in `sessionStorage` keyed by
   `state`, and redirects to the provider's authorization endpoint
   with `response_type=code`, `code_challenge_method=S256`, and the
   scopes listed in the provider section above.
3. The provider redirects back to `http://localhost:3000/oidc?code=…&state=…`.
   The page detects the `code` query param, pulls the matching
   `code_verifier` from `sessionStorage`, and posts to the provider's
   token endpoint.
4. The response includes an `id_token`. The page parses the JWT
   payload with `parseIdTokenClaims` from `@noy-db/on-oidc` and
   renders the decoded claims (`sub`, `iss`, `email`, `name`,
   `exp`) in a table.
5. A second button — **Enroll this device** — is enabled once the
   `id_token` is held. It wires the claims into `enrollOidc()` against
   the configured key-connector URL. After enrollment, the
   **Unlock with OIDC** button replays `unlockOidc()` using the same
   `id_token`.

Only the first two steps (OIDC handshake + claim display) are
provider-specific. Enrollment and unlock are identical across every
provider because NOYDB's split-key model only needs `sub` + a
verifiable `id_token`.

For the automated equivalent see
`showcases/src/12-oidc-bridge.showcase.test.ts` — it runs the full
enroll-then-unlock flow against a mocked provider and mocked
key-connector, asserting the ciphertext round-trip and the lockout
behaviour when the device secret is cleared.

---

*Provider setup guide last updated: v0.12.0 — 2026-04-20.*
