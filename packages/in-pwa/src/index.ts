/**
 * **@noy-db/in-pwa** — installable/offline shell helpers for noy-db SPAs.
 *
 * The premise: **the PWA starts empty.** First open in its own storage
 * partition runs online enrollment and hydrates from the firm cloud
 * store; from then on the installed app is the offline-capable home of
 * the vault (data in `to-browser-idb`, app shell in the SW cache — see
 * the README recipe). This package ships the browser-shell plumbing
 * around that lifecycle:
 *
 * - {@link requestPersistence} — `navigator.storage.persist()` +
 *   `estimate()` with a clear grant/deny signal. Never throws.
 * - {@link guardLocalVault} / {@link probeLocalVault} — detect a
 *   wiped/missing local store at boot and **fail closed** into the
 *   re-enrollment flow. Never a crash, never a silent empty vault
 *   presented as truth.
 * - {@link captureInstallPrompt}, {@link getDisplayContext},
 *   {@link isIosSafari} — install UX helpers.
 * - {@link watchOnline} — online/offline wiring shaped for the sync
 *   engine's `isOnline` flag.
 *
 * No service worker runtime is shipped — the SW is a copy-able recipe
 * in the README. This package holds no keys and sees no plaintext.
 *
 * @packageDocumentation
 */

import type { NoydbStore } from '@noy-db/hub/to'

// ---------------------------------------------------------------------------
// Shared app-shell context contract (also consumed/mirrored by @noy-db/in-liff)
// ---------------------------------------------------------------------------

/**
 * The three shells one noy-db SPA can boot in. Shared contract with
 * `@noy-db/in-liff` (which detects `'liff'`); this package's
 * {@link getDisplayContext} distinguishes the other two. A plain string
 * union — no runtime coupling between the packages.
 */
export type AppShellContext = 'liff' | 'browser' | 'pwa'

// ---------------------------------------------------------------------------
// Storage persistence
// ---------------------------------------------------------------------------

/** Result of {@link requestPersistence}. */
export interface PersistenceResult {
  /** True when the origin's storage is durable (not eviction-eligible). */
  persisted: boolean
  /** `navigator.storage.estimate().quota`, when the browser reports it. */
  quota?: number
  /** `navigator.storage.estimate().usage`, when the browser reports it. */
  usage?: number
  /**
   * How the answer was reached:
   * - `'already'` — the origin was persistent before this call.
   * - `'granted'` — `persist()` was requested and the browser granted it.
   * - `'denied'` — `persist()` was requested and the browser declined.
   * - `'unsupported'` — no Storage API on this browser (or it errored).
   */
  grantedBy: 'already' | 'granted' | 'denied' | 'unsupported'
}

/**
 * Ask the browser to mark this origin's storage as persistent and report
 * quota/usage. Eviction of the local vault is the top PWA risk (iOS ITP
 * evicts script-writable storage of non-installed web content after ~7
 * days of disuse; installed home-screen apps are safer) — call this
 * during enrollment and surface a warning UI on `'denied'`.
 *
 * Never throws: unsupported browsers resolve to
 * `{ persisted: false, grantedBy: 'unsupported' }`.
 */
export async function requestPersistence(): Promise<PersistenceResult> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
  if (!storage || typeof storage.persist !== 'function') {
    return { persisted: false, grantedBy: 'unsupported' }
  }

  let persisted = false
  let grantedBy: PersistenceResult['grantedBy']
  try {
    const already = typeof storage.persisted === 'function' ? await storage.persisted() : false
    if (already) {
      persisted = true
      grantedBy = 'already'
    } else {
      persisted = await storage.persist()
      grantedBy = persisted ? 'granted' : 'denied'
    }
  } catch {
    // A throwing Storage API is indistinguishable from an absent one
    // for the caller's purposes — report unsupported, never throw.
    return { persisted: false, grantedBy: 'unsupported' }
  }

  const result: PersistenceResult = { persisted, grantedBy }
  if (typeof storage.estimate === 'function') {
    try {
      const est = await storage.estimate()
      if (typeof est.quota === 'number') result.quota = est.quota
      if (typeof est.usage === 'number') result.usage = est.usage
    } catch {
      // estimate() failing must not mask the persistence answer.
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Eviction guard
// ---------------------------------------------------------------------------

/** Outcome of {@link probeLocalVault}. */
export type VaultPresence =
  | {
      present: true
      /**
       * What proved presence: `'keyring'` — the vault's `_keyring`
       * marker records exist (every encrypted vault persists one at
       * creation); `'envelopes'` — no keyring (plaintext-mode vault)
       * but `loadAll()` returned at least one envelope.
       */
      via: 'keyring' | 'envelopes'
    }
  | {
      present: false
      /**
       * `'empty'` — the store answered and holds nothing for this
       * vault (wiped/evicted/never enrolled); `'probe-failed'` — the
       * store itself errored. Both fail closed.
       */
      reason: 'empty' | 'probe-failed'
      /** The underlying error when `reason` is `'probe-failed'`. */
      cause?: unknown
    }

/**
 * Cheap, store-agnostic probe: is a local vault actually present in
 * `store`? Works against any `NoydbStore` (the 6-method contract from
 * `@noy-db/hub/to`) — it never touches `to-browser-idb` internals.
 *
 * Presence check, in order:
 * 1. `store.list(vaultId, '_keyring')` — an encrypted vault always
 *    persists its owner keyring record at creation, so a non-empty
 *    `_keyring` collection is the same marker the hub itself uses to
 *    decide a vault is provisioned. One tiny `list()` call.
 * 2. Fallback for plaintext-mode vaults (no keyring): `loadAll()` —
 *    any envelope in any collection counts as present.
 *
 * Never throws — a store error resolves to
 * `{ present: false, reason: 'probe-failed', cause }`.
 */
export async function probeLocalVault(store: NoydbStore, vaultId: string): Promise<VaultPresence> {
  try {
    const keyringIds = await store.list(vaultId, '_keyring')
    if (keyringIds.length > 0) return { present: true, via: 'keyring' }

    const snapshot = await store.loadAll(vaultId)
    for (const records of Object.values(snapshot)) {
      if (records && Object.keys(records).length > 0) {
        return { present: true, via: 'envelopes' }
      }
    }
    return { present: false, reason: 'empty' }
  } catch (cause) {
    return { present: false, reason: 'probe-failed', cause }
  }
}

/** Result of {@link guardLocalVault}. */
export interface GuardResult {
  /** True iff the local vault is present. Never true on a failed probe. */
  healthy: boolean
  /** The underlying probe outcome. */
  presence: VaultPresence
}

/**
 * Boot-time eviction guard: probe the local store and **fail closed**
 * into re-enrollment when the vault is gone.
 *
 * - Vault present → `{ healthy: true }`; `onEvicted` is not called.
 * - Vault missing (wiped/evicted partition) **or the probe itself
 *   failed** → `onEvicted` is invoked (and awaited) with the failure
 *   detail, then `{ healthy: false }` is returned. A broken store is
 *   treated exactly like a missing vault — the guard never presents an
 *   empty or unreadable store as a healthy vault, and never throws
 *   from the probe path.
 *
 * `onEvicted` is where the app routes to its re-enrollment flow (the
 * online re-invite via `@noy-db/on-oidc`); errors thrown by the handler
 * itself propagate to the caller.
 */
export async function guardLocalVault(
  store: NoydbStore,
  vaultId: string,
  onEvicted: (presence: Extract<VaultPresence, { present: false }>) => void | Promise<void>,
): Promise<GuardResult> {
  const presence = await probeLocalVault(store, vaultId)
  if (presence.present) return { healthy: true, presence }
  await onEvicted(presence)
  return { healthy: false, presence }
}

// ---------------------------------------------------------------------------
// Install UX helpers
// ---------------------------------------------------------------------------

/**
 * The `beforeinstallprompt` event shape (Chromium-only, not in the DOM
 * lib types).
 */
interface BeforeInstallPromptLike extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** Handle returned by {@link captureInstallPrompt}. */
export interface CapturedInstallPrompt {
  /** True once a `beforeinstallprompt` event has been captured (and not yet spent). */
  readonly captured: boolean
  /**
   * Re-fire the deferred browser install prompt. Resolves to the user's
   * choice, or `'unavailable'` when no event was captured (iOS, already
   * installed, or the prompt was already spent — the browser fires it
   * at most once per capture).
   */
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>
  /** Remove the event listener and drop any captured prompt. */
  dispose(): void
}

/**
 * Capture the `beforeinstallprompt` event (Android/desktop Chromium) so
 * the app can show its own install UI and re-fire the prompt on a user
 * gesture. Call once at boot, before the browser fires the event.
 *
 * On browsers that never fire the event (iOS Safari — see
 * {@link isIosSafari} for the add-to-home-screen interstitial decision)
 * `promptInstall()` simply resolves `'unavailable'`.
 */
export function captureInstallPrompt(target?: EventTarget): CapturedInstallPrompt {
  const t = target ?? (globalThis as { window?: EventTarget }).window
  let deferred: BeforeInstallPromptLike | null = null

  const listener = (event: Event): void => {
    // Suppress the browser's own mini-infobar; the app re-fires the
    // prompt from its install UI instead.
    event.preventDefault()
    deferred = event as BeforeInstallPromptLike
  }
  t?.addEventListener('beforeinstallprompt', listener)

  return {
    get captured() {
      return deferred !== null
    },
    async promptInstall() {
      const event = deferred
      if (!event || typeof event.prompt !== 'function') return 'unavailable'
      deferred = null // the deferred prompt is single-use
      await event.prompt()
      const choice = await event.userChoice
      return choice.outcome
    },
    dispose() {
      t?.removeEventListener('beforeinstallprompt', listener)
      deferred = null
    },
  }
}

/**
 * Which shell the app is currently displayed in: `'pwa'` when running
 * standalone (installed — `display-mode: standalone` media query, or
 * iOS `navigator.standalone`), else `'browser'`. The `'liff'` value of
 * {@link AppShellContext} is detected by `@noy-db/in-liff`, not here.
 */
export function getDisplayContext(): Extract<AppShellContext, 'pwa' | 'browser'> {
  const g = globalThis as {
    matchMedia?: (query: string) => { matches: boolean }
    navigator?: { standalone?: boolean }
  }
  try {
    if (typeof g.matchMedia === 'function' && g.matchMedia('(display-mode: standalone)').matches) {
      return 'pwa'
    }
  } catch {
    // matchMedia throwing (non-browser host) means not standalone.
  }
  if (g.navigator?.standalone === true) return 'pwa'
  return 'browser'
}

/**
 * True on iOS Safari (including iPadOS masquerading as macOS), where
 * `beforeinstallprompt` never fires and installing means the share-sheet
 * "Add to Home Screen" flow — the signal for showing that interstitial.
 * Third-party iOS browsers (Chrome/Firefox/Edge/Opera shells) return
 * false.
 */
export function isIosSafari(): boolean {
  const nav = (globalThis as {
    navigator?: { userAgent?: string; platform?: string; maxTouchPoints?: number }
  }).navigator
  if (!nav) return false
  const ua = nav.userAgent ?? ''
  const iosDevice =
    /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  if (!iosDevice) return false
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua)
}

// ---------------------------------------------------------------------------
// Online/offline transitions
// ---------------------------------------------------------------------------

/**
 * Watch connectivity: invokes `callback` immediately with the current
 * `navigator.onLine` state, then on every `online`/`offline` event.
 * Returns an unsubscribe function.
 *
 * Shaped for feeding the sync engine's `isOnline` flag (this package
 * deliberately does not import the sync engine):
 *
 * ```ts
 * const stop = watchOnline((online) => syncStrategy.setOnline(online))
 * ```
 *
 * In hosts without a `window`/events (or without `navigator.onLine`)
 * the callback fires once with `true` (assume online) and the returned
 * unsubscribe is a no-op.
 */
export function watchOnline(
  callback: (online: boolean) => void,
  target?: EventTarget,
): () => void {
  const g = globalThis as { window?: EventTarget; navigator?: { onLine?: boolean } }
  const t = target ?? g.window
  callback(g.navigator?.onLine ?? true)

  if (!t || typeof t.addEventListener !== 'function') return () => {}
  const onOnline = (): void => callback(true)
  const onOffline = (): void => callback(false)
  t.addEventListener('online', onOnline)
  t.addEventListener('offline', onOffline)
  return () => {
    t.removeEventListener('online', onOnline)
    t.removeEventListener('offline', onOffline)
  }
}
