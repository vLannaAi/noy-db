<!--
  Interactive OIDC demo — multi-provider login configurable via .env.

  Each provider appears as a button only when its client ID is set in
  `playground/nuxt/.env` (copy `.env.example`). Clicking kicks off the
  real OAuth 2.0 authorization-code + PKCE flow; when the provider
  redirects back with `?code=...`, this page exchanges the code for an
  `id_token` and displays the parsed claims.

  The page demonstrates that real provider tokens arrive in the shape
  `@noy-db/on-oidc` expects. It does NOT wrap a keyring here (no
  key-connector is running in the browser) — see
  `showcases/src/12-oidc-bridge.showcase.test.ts` for the full
  enrollOidc / unlockOidc round-trip against a mock key-connector.

  Setup walkthroughs per provider: docs/oidc-providers.md.
-->

<script setup lang="ts">
import { parseIdTokenClaims } from '@noy-db/on-oidc'

// ─── Provider catalogue ─────────────────────────────────────────────
//
// Each entry describes how to build an authorize URL + token-exchange
// request for one OIDC provider. `clientId` is read from
// `useRuntimeConfig().public.oidc.*` at render time — providers whose
// client ID is blank get filtered out before rendering.

interface Provider {
  id: 'google' | 'apple' | 'line' | 'meta' | 'auth0' | 'keycloak'
  name: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string
  clientId: string
  // Some flows need `response_mode=form_post` (Apple) — mostly opaque.
  extraAuthorizeParams?: Record<string, string>
}

const config = useRuntimeConfig().public.oidc as Record<string, string>

function buildProviders(): Provider[] {
  const items: Provider[] = [
    {
      id: 'google',
      name: 'Google',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'openid profile email',
      clientId: config['googleClientId'] ?? '',
    },
    {
      id: 'apple',
      name: 'Apple',
      authorizeUrl: 'https://appleid.apple.com/auth/authorize',
      tokenUrl: 'https://appleid.apple.com/auth/token',
      scopes: 'openid name email',
      clientId: config['appleClientId'] ?? '',
      extraAuthorizeParams: { response_mode: 'fragment' },
    },
    {
      id: 'line',
      name: 'LINE',
      authorizeUrl: 'https://access.line.me/oauth2/v2.1/authorize',
      tokenUrl: 'https://api.line.me/oauth2/v2.1/token',
      scopes: 'openid profile',
      clientId: config['lineChannelId'] ?? '',
    },
    {
      id: 'meta',
      name: 'Meta / Facebook',
      authorizeUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
      scopes: 'openid email public_profile',
      clientId: config['metaClientId'] ?? '',
    },
    {
      id: 'auth0',
      name: 'Auth0',
      authorizeUrl: config['auth0Domain']
        ? `https://${config['auth0Domain']}/authorize`
        : '',
      tokenUrl: config['auth0Domain']
        ? `https://${config['auth0Domain']}/oauth/token`
        : '',
      scopes: 'openid profile email',
      clientId: config['auth0ClientId'] ?? '',
    },
    {
      id: 'keycloak',
      name: 'Keycloak',
      authorizeUrl: config['keycloakIssuer']
        ? `${config['keycloakIssuer']}/protocol/openid-connect/auth`
        : '',
      tokenUrl: config['keycloakIssuer']
        ? `${config['keycloakIssuer']}/protocol/openid-connect/token`
        : '',
      scopes: 'openid profile email',
      clientId: config['keycloakClientId'] ?? '',
    },
  ]
  return items.filter((p) => p.clientId.length > 0 && p.authorizeUrl.length > 0)
}

const providers = ref<Provider[]>([])

// Session state
const busy = ref(false)
const error = ref<string | null>(null)
const idToken = ref<string | null>(null)
const claims = ref<Record<string, unknown> | null>(null)

// ─── PKCE helpers ───────────────────────────────────────────────────
// Authorization-code + PKCE keeps the client secret out of the browser.

function randomString(length: number): string {
  const bytes = new Uint8Array(length)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62])
    .join('')
}

async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const hash = await window.crypto.subtle.digest('SHA-256', bytes)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function redirectUri(): string {
  return `${window.location.origin}/oidc`
}

// ─── Start flow ─────────────────────────────────────────────────────

async function startLogin(provider: Provider) {
  const state = randomString(24)
  const verifier = randomString(64)
  const challenge = await sha256Base64Url(verifier)

  // Persist the pieces we'll need on the callback leg. sessionStorage
  // survives the redirect roundtrip but is cleared when the tab closes.
  sessionStorage.setItem('noydb-oidc-provider', JSON.stringify(provider))
  sessionStorage.setItem('noydb-oidc-verifier', verifier)
  sessionStorage.setItem('noydb-oidc-state', state)

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: provider.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...(provider.extraAuthorizeParams ?? {}),
  })
  window.location.href = `${provider.authorizeUrl}?${params.toString()}`
}

// ─── Callback handler ───────────────────────────────────────────────

async function handleCallback(code: string, stateFromUrl: string) {
  const raw = sessionStorage.getItem('noydb-oidc-provider')
  const verifier = sessionStorage.getItem('noydb-oidc-verifier')
  const expectedState = sessionStorage.getItem('noydb-oidc-state')

  if (!raw || !verifier || stateFromUrl !== expectedState) {
    throw new Error('Missing or mismatched PKCE state — restart the flow.')
  }
  const provider = JSON.parse(raw) as Provider

  // Public-client token exchange (no client_secret — PKCE is the
  // integrity check). Some providers (Google, Auth0, Keycloak, LINE)
  // accept this natively for SPAs. Apple and Meta may require extra
  // steps noted in docs/oidc-providers.md.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: provider.clientId,
    code_verifier: verifier,
    code,
    redirect_uri: redirectUri(),
  })

  const resp = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!resp.ok) {
    throw new Error(
      `Token exchange failed: ${resp.status} ${await resp.text()}`,
    )
  }
  const json = (await resp.json()) as { id_token?: string }
  if (!json.id_token) {
    throw new Error(
      "Provider did not return an id_token. " +
        "This is expected for Meta's standard web flow; see docs/oidc-providers.md.",
    )
  }
  idToken.value = json.id_token
  claims.value = parseIdTokenClaims(json.id_token) as unknown as Record<string, unknown>

  // One-shot — scrub the URL so a refresh doesn't re-run the exchange.
  sessionStorage.removeItem('noydb-oidc-provider')
  sessionStorage.removeItem('noydb-oidc-verifier')
  sessionStorage.removeItem('noydb-oidc-state')
  window.history.replaceState({}, '', '/oidc')
}

function handleReset() {
  idToken.value = null
  claims.value = null
  error.value = null
}

function openDocs() {
  window.open(
    'https://github.com/vLannaAi/noy-db/blob/main/docs/oidc-providers.md',
    '_blank',
  )
}

onMounted(async () => {
  providers.value = buildProviders()

  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const stateFromUrl = url.searchParams.get('state')
  const providerError = url.searchParams.get('error')

  if (providerError) {
    error.value = `Provider returned error: ${providerError} — ${url.searchParams.get('error_description') ?? ''}`
    window.history.replaceState({}, '', '/oidc')
    return
  }

  if (code && stateFromUrl) {
    busy.value = true
    try {
      await handleCallback(code, stateFromUrl)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      busy.value = false
    }
  }
})
</script>

<template>
  <section>
    <h2>OIDC login — multi-provider demo</h2>
    <p class="lede">
      Configure one or more providers in
      <code>playground/nuxt/.env</code> (copy
      <code>.env.example</code>). Setup instructions per provider:
      <NuxtLink to="/oidc" @click.prevent="openDocs">docs/oidc-providers.md</NuxtLink>.
    </p>

    <ClientOnly>
      <div v-if="busy" class="loading">Exchanging authorization code…</div>

      <!-- Callback success: show claims -->
      <section v-else-if="claims && idToken" class="stage success">
        <h3>✓ Signed in — ID token received</h3>
        <p>
          The provider returned a valid ID token. Its parsed claims are
          below. In a real app you'd pass the token to
          <code>enrollOidc()</code> or <code>unlockOidc()</code> to
          reconstruct the vault's KEK via the key-connector.
        </p>
        <pre>{{ JSON.stringify(claims, null, 2) }}</pre>
        <details>
          <summary>Raw ID token (don't post this anywhere)</summary>
          <pre>{{ idToken }}</pre>
        </details>
        <div class="actions">
          <button @click="handleReset">Sign out / start over</button>
        </div>
      </section>

      <!-- No providers configured -->
      <section v-else-if="providers.length === 0" class="stage warn">
        <h3>No OIDC providers configured</h3>
        <p>
          Copy <code>playground/nuxt/.env.example</code> →
          <code>.env</code> and fill in a client ID for at least one
          provider. See
          <NuxtLink to="/oidc" @click.prevent="openDocs">docs/oidc-providers.md</NuxtLink>
          for walkthroughs.
        </p>
        <p class="muted">
          Easiest options: <strong>Google</strong> (5 min setup),
          <strong>Keycloak</strong> (Docker one-liner, offline-capable),
          <strong>LINE</strong> (free, popular in Asia).
        </p>
      </section>

      <!-- Provider buttons -->
      <section v-else class="stage">
        <h3>Choose a provider</h3>
        <p>
          {{ providers.length }} provider(s) configured. Clicking below
          redirects to the provider's authorize endpoint; after
          authentication the callback lands back here with an ID token.
        </p>
        <div class="providers">
          <button
            v-for="p in providers"
            :key="p.id"
            class="provider-button"
            @click="startLogin(p)"
          >
            Sign in with {{ p.name }}
          </button>
        </div>
      </section>

      <div v-if="error" class="error">
        <strong>Error:</strong> {{ error }}
      </div>

      <template #fallback>
        <p class="loading">Loading…</p>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.lede {
  color: #4b5563;
  font-size: 0.95rem;
}

.stage {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1.25rem 1.5rem;
  margin: 1rem 0;
}

.stage h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1.1rem;
}

.stage.success {
  border-color: #059669;
  background: #ecfdf5;
}

.stage.warn {
  background: #fef3c7;
  border-color: #f59e0b;
}

.providers {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.provider-button {
  text-align: left;
  padding: 0.75rem 1rem;
  border: 1px solid #d1d5db;
  background: white;
  color: #1f2937;
}

.provider-button:hover {
  background: #f3f4f6;
  border-color: #2563eb;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.muted {
  color: #6b7280;
  font-size: 0.9rem;
}

.loading {
  color: #6b7280;
  font-style: italic;
}

.error {
  background: #fee2e2;
  color: #b91c1c;
  padding: 0.75rem 1rem;
  border-radius: 0.25rem;
  margin-top: 1rem;
}

details {
  margin: 0.75rem 0;
  font-size: 0.85rem;
}

details summary {
  cursor: pointer;
  color: #2563eb;
  user-select: none;
}

pre {
  background: #1f2937;
  color: #e5e7eb;
  padding: 0.75rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
  overflow-x: auto;
  margin: 0.5rem 0;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
