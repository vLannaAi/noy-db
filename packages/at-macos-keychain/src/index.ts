/**
 * **@noy-db/at-macos-keychain** — macOS Keychain sealing key provider
 * for noy-db [managed-passphrase mode](https://github.com/vLannaAi/noy-db/issues/14).
 *
 * Desktop-app provider in the `at-*` family. Binds the sealing key to
 * the user's macOS login Keychain — accessible only to processes
 * running as the same user, optionally gated by Touch ID via Keychain
 * Access UI (a one-time per-entry toggle the user enables themselves;
 * this package does not gate that programmatically).
 *
 * ## When to use
 *
 * - Desktop apps where the user expects "log into my Mac = open the
 *   vault." The Keychain entry persists across reboots, scoped to
 *   the user account.
 * - Apps where `at-env` is unsuitable — laptops or shared dev machines
 *   where other users with shell access can `echo $NOYDB_SEALING_KEY`
 *   and exfiltrate the key.
 *
 * ## When NOT to use
 *
 * - Server-side / containerized deployments — there is no Keychain
 *   there. Use `@noy-db/at-env` or `@noy-db/at-aws-kms` (when it
 *   ships).
 * - Browser apps — Keychain is a native OS feature, not exposed to
 *   browser sandboxes. Use `@noy-db/at-webauthn-prf` (when it ships).
 *
 * ## Setup
 *
 * ```bash
 * pnpm add @noy-db/hub @noy-db/at-macos-keychain @napi-rs/keyring
 * ```
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { macosKeychainSealingProvider } from '@noy-db/at-macos-keychain'
 *
 * const db = await createNoydb({
 *   store,
 *   user: 'alice',
 *   passphraseMode: 'managed',
 *   sealingKey: macosKeychainSealingProvider({
 *     service: 'com.acme.app',         // your bundle id / app namespace
 *     account: 'alice@acme.example',   // per-user keychain item
 *   }),
 * })
 * ```
 *
 * First call generates a fresh 32-byte AES-256 key, stores it in the
 * Keychain under `(service, account)`, and uses it to seal the
 * hub-generated managed passphrase. Subsequent process launches
 * retrieve the same key and unseal transparently.
 *
 * ## Threat model
 *
 * The Keychain entry IS the security boundary. Strength bounded by:
 *
 * - **macOS user-account isolation.** Other processes running as the
 *   same user can read the entry. macOS App Sandboxing limits this
 *   for App Store apps; unsandboxed apps must trust co-resident
 *   processes.
 * - **Login keychain lock state.** When the user's login keychain
 *   is locked (default: never, unless explicitly configured), reads
 *   surface a prompt or fail. Apps that need to operate when the
 *   keychain is locked should consider explicit unlock UX.
 * - **Touch ID upgrade.** Users may add Touch ID gating to the
 *   Keychain entry via Keychain Access.app → right-click → Get Info
 *   → Access Control. This is opt-in per entry and out of band of
 *   this package's API.
 *
 * Does NOT protect against:
 *
 * - Malware running as the same user with Keychain access.
 * - A physically present attacker who knows the user's login
 *   password and can unlock the keychain.
 * - macOS itself being compromised below the Keychain Services
 *   layer.
 *
 * @packageDocumentation
 */

import type { SealingKeyProvider } from '@noy-db/hub'

/**
 * Structural shape of `@napi-rs/keyring`'s `Entry` class.
 *
 * Defined here as a structural type rather than importing the
 * concrete class so that:
 *
 *   1. Test code can inject a memory-backed stub for cross-platform
 *      unit tests (the real Entry only works on darwin/win32/linux).
 *   2. We don't pin a specific version of `@napi-rs/keyring`'s
 *      exported types — the structural match is exact across 1.x.
 *
 * @public
 */
export interface KeychainEntry {
  /** Returns the stored secret, or `null` when no entry exists. */
  getPassword(): string | null
  /** Persists the secret. Overwrites any existing value. */
  setPassword(value: string): void
  /** Removes the entry. Returns `true` if an entry was removed. */
  deletePassword(): boolean
}

/**
 * Options for {@link macosKeychainSealingProvider}.
 *
 * The pair `(service, account)` becomes the Keychain lookup key. By
 * convention:
 *
 * - `service` is your app's bundle id or stable app namespace, e.g.
 *   `'com.acme.app'`. Stable across users; identifies the app.
 * - `account` is per-user, typically the user's email or stable
 *   user id, e.g. `'alice@acme.example'`. Different users = different
 *   Keychain entries.
 */
export interface MacosKeychainSealingProviderOptions {
  /** Keychain service identifier — typically your app's bundle id. */
  readonly service: string
  /** Per-user account identifier inside the service. */
  readonly account: string
  /**
   * Test-injection hook. Pass a pre-constructed `KeychainEntry`
   * (e.g., a memory-backed stub) to bypass the real Keychain. The
   * production code path defaults to `new Entry(service, account)`
   * from `@napi-rs/keyring`.
   *
   * @internal — production callers should leave undefined.
   */
  readonly entry?: KeychainEntry
}

/**
 * Build a {@link SealingKeyProvider} backed by a macOS Keychain entry.
 *
 * The 32-byte AES-256-GCM sealing key is generated on first use and
 * persisted in the Keychain under `(service, account)`. Subsequent
 * calls (this process or any future process running as the same
 * user) retrieve the same key — the vault round-trips across
 * restarts.
 *
 * Provider `id` format: `macos-keychain:{service}/{account}`. The
 * format is semver-frozen per the §11.9.1 stability rule; see
 * `docs/subsystems/sealing-pid-stability.md`.
 *
 * @throws Error at construction if `service` or `account` is empty,
 *   or on non-darwin platforms (with a pointer to platform-appropriate
 *   providers).
 */
export function macosKeychainSealingProvider(
  opts: MacosKeychainSealingProviderOptions,
): SealingKeyProvider {
  if (!opts.service || typeof opts.service !== 'string') {
    throw new Error(
      '@noy-db/at-macos-keychain: `service` is required, must be a non-empty string. '
      + 'Typically your app bundle id (e.g., "com.acme.app").',
    )
  }
  if (!opts.account || typeof opts.account !== 'string') {
    throw new Error(
      '@noy-db/at-macos-keychain: `account` is required, must be a non-empty string. '
      + 'Typically the user\'s email or stable user id (e.g., "alice@acme.example").',
    )
  }

  // Hard platform check unless the caller supplied a test stub.
  // Per §11.9.1 spec Q.3: fail loudly on the wrong platform.
  if (opts.entry === undefined && process.platform !== 'darwin') {
    throw new Error(
      `@noy-db/at-macos-keychain: refusing to construct provider on `
      + `platform "${process.platform}". This package only operates on `
      + 'darwin (macOS). For other platforms use @noy-db/at-env (server), '
      + '@noy-db/at-wincred (Windows desktop), @noy-db/at-libsecret (Linux desktop), '
      + 'or @noy-db/at-webauthn-prf (browser).',
    )
  }

  // Resolved lazily so that production callers don't pay the require
  // cost (or fail loudly on wrong platform) until they actually invoke
  // seal/unseal. Construction-site failure of new Entry() on unsupported
  // platforms is caught and rethrown with a clearer message.
  let resolvedEntry: KeychainEntry | undefined = opts.entry
  const getEntry = (): KeychainEntry => {
    if (resolvedEntry) return resolvedEntry
    // Dynamic require so non-darwin imports don't crash on package load.
    // The platform check above guards production callers; this branch
    // only runs for production (opts.entry was undefined) on darwin.
    /* eslint-disable @typescript-eslint/no-require-imports */
    let Entry: new (service: string, account: string) => KeychainEntry
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = require('@napi-rs/keyring') as { Entry: any }
      Entry = mod.Entry
    } catch (err) {
      throw new Error(
        '@noy-db/at-macos-keychain: failed to load `@napi-rs/keyring`. '
        + 'Ensure it is installed (`pnpm add @napi-rs/keyring`) and that '
        + 'the platform-specific binary for darwin is available. '
        + 'Original error: '
        + (err instanceof Error ? err.message : String(err)),
      )
    }
    /* eslint-enable */
    resolvedEntry = new Entry(opts.service, opts.account)
    return resolvedEntry
  }

  // Cache the imported CryptoKey for the lifetime of this provider
  // instance. Matches at-env's pattern; avoids a Keychain round-trip
  // per seal/unseal operation in long-running processes.
  let cachedKey: Promise<CryptoKey> | null = null
  const getKey = (): Promise<CryptoKey> => {
    if (!cachedKey) {
      cachedKey = (async (): Promise<CryptoKey> => {
        const entry = getEntry()
        let stored = entry.getPassword()
        if (stored === null) {
          // First call ever for this (service, account) — generate a
          // fresh 32-byte AES-256 key, base64-encode for string
          // storage, persist.
          const fresh = new Uint8Array(32)
          globalThis.crypto.getRandomValues(fresh)
          entry.setPassword(bytesToBase64(fresh))
          stored = entry.getPassword()
          if (stored === null) {
            throw new Error(
              '@noy-db/at-macos-keychain: setPassword succeeded but '
              + 'getPassword returned null immediately after. '
              + 'Keychain may be denying access or the entry was '
              + 'deleted out from under us.',
            )
          }
        }
        const keyBytes = base64ToBytes(stored)
        if (keyBytes.length !== 32) {
          throw new Error(
            `@noy-db/at-macos-keychain: stored key for service="${opts.service}" `
            + `account="${opts.account}" decodes to ${keyBytes.length} bytes; `
            + 'expected 32. The Keychain entry may have been tampered with — '
            + 'delete the entry (Keychain Access.app → search → right-click → Delete) '
            + 'and reopen the vault to regenerate.',
          )
        }
        return globalThis.crypto.subtle.importKey(
          'raw',
          keyBytes as unknown as BufferSource,
          'AES-GCM',
          false,
          ['encrypt', 'decrypt'],
        )
      })()
    }
    return cachedKey
  }

  return {
    id: `macos-keychain:${opts.service}/${opts.account}`,

    async seal(passphrase: Uint8Array): Promise<Uint8Array> {
      const key = await getKey()
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        passphrase as unknown as BufferSource,
      )
      // Output format: [12-byte IV][ciphertext + 16-byte GCM tag]
      // Identical wire layout to at-env, by design — the hub envelope
      // dispatches on pid, not on per-provider format.
      const out = new Uint8Array(12 + ciphertext.byteLength)
      out.set(iv, 0)
      out.set(new Uint8Array(ciphertext), 12)
      return out
    },

    async unseal(sealed: Uint8Array): Promise<Uint8Array> {
      // 12-byte IV + ≥ 16-byte GCM tag minimum.
      if (sealed.length < 12 + 16) {
        throw new Error(
          `@noy-db/at-macos-keychain: sealed bytes too short (${sealed.length} < 28). `
          + 'Input is not a valid at-macos-keychain-sealed envelope.',
        )
      }
      const iv = sealed.subarray(0, 12)
      const body = sealed.subarray(12)
      const key = await getKey()
      const plaintext = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        body as unknown as BufferSource,
      )
      return new Uint8Array(plaintext)
    },
  }
}

// ─── base64 helpers (browser + node compatible) ──────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.trim())) {
    throw new Error('input contains characters outside the base64 alphabet')
  }
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
