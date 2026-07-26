/**
 * **@noy-db/in-liff** — LIFF (LINE Front-end Framework) shell binding for
 * noy-db: boot + shell-context detection across the three shells one
 * portal SPA runs in (inside LINE, external browser, installed PWA),
 * LINE ID-token lifecycle with re-login on expiry, share-link deep-link
 * ingestion, and the external-browser escape hatch.
 *
 * The LIFF SDK is **injected, never depended on**: every entry point
 * takes a {@link LiffLike} — the structural slice of the `liff` global
 * this package actually calls — so apps pass the real `liff` object and
 * tests pass fakes. CI runs fully mocked, per family convention.
 *
 * Platform truths this package encodes (the portal handoff matrix):
 * - **Android**: an in-scope link opened via {@link openExternal} lands
 *   in the installed PWA directly (WebAPK link capture); the WebAPK
 *   shares Chrome's origin storage.
 * - **iOS**: links always open Safari; an installed home-screen app
 *   cannot be targeted by URL and has its own storage partition — the
 *   handoff is a manual hop behind an interstitial.
 * - **LINE's in-app WebView storage is always isolated** — moving to
 *   another shell is a re-enroll + re-sync ceremony (see
 *   `@noy-db/on-oidc`'s firm re-invite flow), never a data transfer.
 * - **No WebAuthn inside LINE's WebView** — the in-LINE lock options are
 *   PIN and device-trust (`@noy-db/on-pin`); biometric unlocks become
 *   available only in the external-browser/PWA shells. IndexedDB and
 *   `crypto.subtle` are available in all three shells.
 *
 * @packageDocumentation
 */

import { parseShareLink, ShareLinkParseError } from '@noy-db/hub/share-link'
import type { ShareLink } from '@noy-db/hub/share-link'

/**
 * Which shell the SPA is running in. Mirrors the union exported by
 * `@noy-db/in-pwa` — kept as a structural redeclaration (identical
 * string union) rather than an import so neither satellite depends on
 * the other; satellites peer-depend only on the hub, per family law.
 */
export type AppShellContext = 'liff' | 'browser' | 'pwa'

/**
 * The structural slice of the LIFF SDK this package calls. Pass the
 * real `liff` global in apps; pass a fake in tests. Only these six
 * members are ever touched — messaging/share APIs are out of scope.
 */
export interface LiffLike {
  init(config: { liffId: string }): Promise<void>
  isLoggedIn(): boolean
  /** Navigates away to LINE Login in a real LIFF runtime. */
  login(options?: { redirectUri?: string }): void
  getIDToken(): string | null
  isInClient(): boolean
  openWindow(params: { url: string; external?: boolean }): void
}

/** Thrown when `liff.init` fails — the shell cannot be established. */
export class LiffInitError extends Error {
  readonly code = 'LIFF_INIT_FAILED'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LiffInitError'
  }
}

/**
 * Thrown for ID-token problems this package can detect client-side:
 * a structurally malformed JWT, or expiry when the caller opted into
 * `onExpired: 'throw'`. Signature verification is NEVER done here —
 * that is the key-connector server's job (see `@noy-db/on-oidc`).
 */
export class LiffTokenError extends Error {
  readonly code: 'LIFF_TOKEN_EXPIRED' | 'LIFF_TOKEN_MALFORMED'
  constructor(code: 'LIFF_TOKEN_EXPIRED' | 'LIFF_TOKEN_MALFORMED', message: string) {
    super(message)
    this.name = 'LiffTokenError'
    this.code = code
  }
}

/** Everything {@link initLiffApp} establishes about the running shell. */
export interface LiffAppContext {
  /** 'liff' inside LINE; otherwise the pwa/browser split. */
  readonly shell: AppShellContext
  readonly loggedIn: boolean
  /** LINE ID token when logged in and the SDK yields one; else null. */
  readonly idToken: string | null
  /** `liff.isInClient()` — true only inside LINE's in-app WebView. */
  readonly inClient: boolean
  /**
   * The share link the app was opened with, or null when the current
   * location is not a share link. Only `ShareLinkParseError` is
   * swallowed into null — anything else propagates.
   */
  readonly deepLink: ShareLink | null
}

export interface InitLiffAppOptions {
  liff: LiffLike
  liffId: string
  /**
   * Require a logged-in LINE session, calling `liff.login()` when
   * absent. Default true. NOTE: in a real LIFF runtime `login()`
   * NAVIGATES AWAY — code after it only runs in test fakes or when the
   * user is already logged in.
   */
  requireLogin?: boolean
  /** Current location href override (tests); default `location.href`. */
  locationHref?: string
}

/**
 * Boot the LIFF shell: `liff.init`, optional login enforcement, shell
 * detection, ID-token read, and deep-link ingestion — one call at app
 * start, returning everything the portal needs to route.
 */
export async function initLiffApp(options: InitLiffAppOptions): Promise<LiffAppContext> {
  const { liff, liffId, requireLogin = true } = options
  try {
    await liff.init({ liffId })
  } catch (cause) {
    throw new LiffInitError(
      `initLiffApp: liff.init failed for liffId "${liffId}". ` +
        `Check the LIFF app configuration (endpoint URL, channel).`,
      { cause },
    )
  }

  let loggedIn = liff.isLoggedIn()
  if (requireLogin && !loggedIn) {
    liff.login()
    // Real LIFF navigated away above; a fake may have flipped state.
    loggedIn = liff.isLoggedIn()
  }

  const inClient = liff.isInClient()
  const shell: AppShellContext = inClient ? 'liff' : detectStandalone() ? 'pwa' : 'browser'
  const idToken = loggedIn ? liff.getIDToken() : null

  const href = options.locationHref ?? (typeof location !== 'undefined' ? location.href : undefined)
  let deepLink: ShareLink | null = null
  if (href !== undefined) {
    try {
      deepLink = parseShareLink(href)
    } catch (err) {
      if (!(err instanceof ShareLinkParseError)) throw err
      deepLink = null
    }
  }

  return { shell, loggedIn, idToken, inClient, deepLink }
}

/**
 * The pwa/browser split OUTSIDE LINE. Same rule as
 * `@noy-db/in-pwa`'s `getDisplayContext` (kept in sync by comment, not
 * import): standalone display-mode media query, plus iOS Safari's
 * legacy `navigator.standalone`.
 */
function detectStandalone(): boolean {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) {
      return true
    }
  } catch {
    // matchMedia hostile/absent — fall through to the iOS flag.
  }
  const nav = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { standalone?: boolean })
    : undefined
  return nav?.standalone === true
}

export interface GetFreshIdTokenOptions {
  /**
   * What to do when the token is missing or expired: `'login'`
   * (default) triggers `liff.login()` re-auth and returns null —
   * remember login navigates away in a real LIFF runtime; `'throw'`
   * raises {@link LiffTokenError} for the app to handle.
   */
  onExpired?: 'login' | 'throw'
  /** Clock-skew allowance in seconds. Default 30. */
  skewSeconds?: number
}

/**
 * Return a currently-valid LINE ID token, or handle expiry.
 *
 * LIFF ID tokens live ~1 hour with **no silent refresh** — expiry is
 * detected client-side from the JWT `exp` claim (a 20-line local
 * decode; no network, no signature check — mirrors `@noy-db/on-oidc`'s
 * documented client/server split). An unlocked noy-db session SURVIVES
 * token expiry: the token is only needed again at the next
 * serverHalf fetch (see on-oidc), which is exactly when to call this.
 */
export function getFreshIdToken(
  liff: LiffLike,
  options: GetFreshIdTokenOptions = {},
): string | null {
  const { onExpired = 'login', skewSeconds = 30 } = options
  const token = liff.isLoggedIn() ? liff.getIDToken() : null

  if (token !== null) {
    const exp = decodeJwtExp(token)
    if (exp === null) {
      throw new LiffTokenError(
        'LIFF_TOKEN_MALFORMED',
        'getFreshIdToken: the ID token is not a decodable JWT (missing or unreadable exp claim).',
      )
    }
    if (exp * 1000 > Date.now() + skewSeconds * 1000) return token
  }

  if (onExpired === 'throw') {
    throw new LiffTokenError(
      'LIFF_TOKEN_EXPIRED',
      'getFreshIdToken: the LINE ID token is missing or expired. Re-authenticate via liff.login().',
    )
  }
  liff.login()
  return null
}

/** Decode the `exp` claim (seconds) from a JWT, or null if malformed. */
function decodeJwtExp(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(payload)) as { exp?: unknown }
    return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp : null
  } catch {
    return null
  }
}

/**
 * Escape hatch out of LINE's in-app WebView into the default browser
 * (`liff.openWindow` with `external: true`).
 *
 * What actually happens per platform — the portal handoff matrix:
 * - **Android**: if the installed PWA's scope covers `url`, the link
 *   opens the installed app directly (WebAPK link capture), which
 *   shares Chrome's origin storage.
 * - **iOS**: always opens Safari; the installed home-screen app cannot
 *   be targeted and has a separate storage partition — show an
 *   interstitial for the manual hop.
 * - In every case LINE's WebView storage stays behind: the new shell
 *   starts empty and re-enrolls (custodian re-invite; see
 *   `@noy-db/on-oidc`) — a ceremony, not a data transfer.
 */
export function openExternal(liff: LiffLike, url: string): void {
  liff.openWindow({ url, external: true })
}

export type { ShareLink } from '@noy-db/hub/share-link'
