/**
 * Public `vault.user.*` API surface.
 *
 * Three families:
 *  - Write-self: `me` / `updateMe` / `setMe` — always target the writer's
 *    own keyringId. **Own-only write rule** is structural — no method
 *    exists to write someone else's envelope.
 *  - Read-anyone: `get` / `list` — read other principals' envelopes
 *    (subject to `view-team-profiles` policy gate, wired in #22).
 *  - Reactive: `subscribe` / `live` — in-process event emission on local
 *    writes. Cross-instance updates land via the team/sync engine and
 *    surface to subscribers when the sync diff replays through this API.
 *
 * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
 *
 * @module
 */
import type { NoydbStore } from '../../types.js'
import { PolicyDeniedError } from '../../policy/errors.js'
import type { FactorProof } from '../../policy/types.js'
import {
  loadUserEnvelope,
  saveUserEnvelope,
  listUserEnvelopeIds,
} from './storage.js'
import type { UserEnvelope } from './types.js'

/**
 * Recursive partial. Used for `updateMe(patch)` so callers can hand in
 * deeply-nested partial shapes and have them deep-merged onto the
 * current envelope.
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T

/**
 * Recursive partial with `null` allowed at every level — used by
 * `updateMe` (#57) to express deletion intent in addition to merge.
 *
 * Semantics inside `updateMe`:
 *   - `undefined` (or absent key) — skip; source value preserved
 *   - `null` — delete the key from the resulting envelope
 *   - any other value — overwrite (deep-merge for plain objects,
 *     replace for primitives / arrays)
 *
 * Matches lodash `_.merge` behavior on `null` and Firestore's
 * `FieldValue.delete()` semantics. Loosened from `DeepPartial<T>` per
 * #57; consumers wanting the original "merge-only" surface can keep
 * importing `DeepPartial` and avoid passing `null`.
 */
export type DeepPartialOrNull<T> = T extends object
  ? { [P in keyof T]?: DeepPartialOrNull<T[P]> | null }
  : T

/** Cancel a previously-registered subscription. */
export type Unsubscribe = () => void

/**
 * Optional factor-proof bundle threaded into gated user-envelope
 * operations. Same shape as `Noydb.checkGate(vault, gate, presented)`
 * accepts elsewhere — apps that have already presented a TOTP/email-OTP
 * for this session pass it here to satisfy tightened policies.
 */
export interface UserEnvelopePresented {
  readonly factors?: readonly FactorProof[]
  readonly sharedDevice?: boolean
}

/**
 * Callback used by `UserApi` to validate the active session against a
 * policy gate. Provided by the `Vault` constructor; in production this
 * delegates to `Noydb.checkGate(vault, gate, presented)`. In tests, a
 * no-op stub is fine.
 */
export type UserEnvelopeCheckGate = (
  gate: 'edit-own-profile' | 'view-team-profiles',
  presented?: UserEnvelopePresented,
) => Promise<void>

/**
 * Reactive handle returned by `live()`. `current` is the most recently
 * observed value; `subscribe(cb)` fires on subsequent local writes.
 * `stop()` releases the underlying subscription.
 */
export interface LiveUserEnvelope<T> {
  current(): UserEnvelope<T> | null
  subscribe(cb: (env: UserEnvelope<T> | null) => void): Unsubscribe
  stop(): void
}

interface ChangeListener<T = unknown> {
  (env: UserEnvelope<T> | null): void
}

/**
 * Implementation behind `vault.user`. Constructed once per Vault, holds
 * the writer's keyringId in closure so `updateMe`/`setMe` cannot target
 * any other principal — the own-only rule is enforced at the type level
 * (no `set(otherKeyringId, …)` method) AND at runtime (the
 * keyringId argument simply doesn't exist on the write path).
 */
export class UserApi {
  /** keyringId → set of listeners. Wildcard '*' fires on every change. */
  private readonly listeners = new Map<string, Set<ChangeListener>>()

  constructor(
    private readonly adapter: NoydbStore,
    private readonly vaultName: string,
    /** The writer's own keyringId. Frozen at construction time. */
    private readonly writerKeyringId: string,
    private readonly getDek: () => Promise<CryptoKey>,
    /**
     * Policy-gate validator. When omitted, gates are skipped — useful
     * for low-level tests that exercise the storage layer directly.
     * Production paths always wire the Noydb-backed implementation.
     */
    private readonly checkGate?: UserEnvelopeCheckGate,
  ) {}

  // ─── Write-self ──────────────────────────────────────────────────────

  /** Read the writer's own envelope. Returns null if never written. */
  async me<T = unknown>(): Promise<UserEnvelope<T> | null> {
    const dek = await this.getDek()
    return loadUserEnvelope<T>(this.adapter, this.vaultName, this.writerKeyringId, dek)
  }

  /**
   * Deep-merge a partial patch into the writer's own envelope. Creates
   * the envelope on first call. Optimistic-concurrency safe — a stale
   * `_v` (parallel writer on another device) throws `ConflictError`.
   *
   * Patch semantics (#57):
   *   - `undefined` (or omitted key) — skip; existing value preserved
   *   - `null` — delete the field from the merged result
   *   - any other value — overwrite (deep-merge for plain objects,
   *     replace for primitives / arrays)
   *
   * To clear a field, pass `null` rather than `undefined`. Callers
   * with shape `T = string | null` where `null` is a meaningful value
   * should use `setMe` for that specific field instead — `null` here
   * always means delete.
   *
   * Gated by the `edit-own-profile` policy gate (default `minTier: 3`).
   * Pass `presented` to satisfy tightened policies that require a
   * factor proof (e.g. STRICT_POLICY's TOTP requirement).
   */
  async updateMe<T extends object = Record<string, unknown>>(
    patch: DeepPartialOrNull<T>,
    presented?: UserEnvelopePresented,
  ): Promise<UserEnvelope<T>> {
    if (this.checkGate) await this.checkGate('edit-own-profile', presented)
    const dek = await this.getDek()
    const current = await loadUserEnvelope<T>(
      this.adapter,
      this.vaultName,
      this.writerKeyringId,
      dek,
    )
    const merged: T = current ? deepMerge(current.data, patch) : (patch as unknown as T)
    const written = await saveUserEnvelope<T>(
      this.adapter,
      this.vaultName,
      this.writerKeyringId,
      merged,
      dek,
      current?._v ?? 0,
    )
    this.fireChange(this.writerKeyringId, written)
    return written
  }

  /**
   * Replace the writer's own envelope with `payload`. Use sparingly —
   * `updateMe` is the canonical mutation. No `expectedVersion` check;
   * callers explicitly take last-write-wins semantics.
   *
   * Gated by `edit-own-profile`. See `updateMe` for `presented` usage.
   */
  async setMe<T = unknown>(
    payload: T,
    presented?: UserEnvelopePresented,
  ): Promise<UserEnvelope<T>> {
    if (this.checkGate) await this.checkGate('edit-own-profile', presented)
    const dek = await this.getDek()
    const written = await saveUserEnvelope<T>(
      this.adapter,
      this.vaultName,
      this.writerKeyringId,
      payload,
      dek,
    )
    this.fireChange(this.writerKeyringId, written)
    return written
  }

  // ─── Read-anyone ─────────────────────────────────────────────────────

  /**
   * Read another principal's envelope by their keyringId. Returns null
   * if the principal exists but has no envelope yet, or if the
   * keyringId does not exist at all.
   *
   * Gated by `view-team-profiles` (default `minTier: 2`) — but ONLY for
   * cross-principal reads. Reading your own envelope (`keyringId ===
   * self`) is never gated; that's just `me()` written long-form.
   */
  async get<T = unknown>(
    keyringId: string,
    presented?: UserEnvelopePresented,
  ): Promise<UserEnvelope<T> | null> {
    if (this.checkGate && keyringId !== this.writerKeyringId) {
      await this.checkGate('view-team-profiles', presented)
    }
    const dek = await this.getDek()
    return loadUserEnvelope<T>(this.adapter, this.vaultName, keyringId, dek)
  }

  /**
   * Read every persisted envelope in the vault. Order is store-defined.
   *
   * Gated by `view-team-profiles`. Default policy (`minTier: 2`) lets
   * any authenticated session read all envelopes. Two privacy-strict
   * opt-outs:
   *
   *  - `view-team-profiles.enabled: false` → list() returns only the
   *    caller's own envelope (silent self-fallback, no thrown error).
   *  - `view-team-profiles.minTier: 1` + insufficient tier → throws
   *    `PolicyDeniedError` with `reason: 'insufficient-tier'`. The
   *    caller is expected to elevate, not silently degrade.
   *
   * The asymmetry is deliberate: `enabled: false` is a deliberate
   * design choice ("nobody sees teammate profiles in this app");
   * `insufficient-tier` is "you need to authenticate further". Different
   * UX prompts for different intents.
   */
  async list<T = unknown>(presented?: UserEnvelopePresented): Promise<UserEnvelope<T>[]> {
    if (this.checkGate) {
      try {
        await this.checkGate('view-team-profiles', presented)
      } catch (err) {
        if (err instanceof PolicyDeniedError && err.reason === 'disabled') {
          // Privacy-strict opt-out: quietly return only self.
          const me = await this.me<T>()
          return me ? [me] : []
        }
        throw err
      }
    }
    const dek = await this.getDek()
    const ids = await listUserEnvelopeIds(this.adapter, this.vaultName)
    const envelopes = await Promise.all(
      ids.map((id) => loadUserEnvelope<T>(this.adapter, this.vaultName, id, dek)),
    )
    return envelopes.filter((e): e is UserEnvelope<T> => e !== null)
  }

  // ─── Reactive ────────────────────────────────────────────────────────

  /**
   * Listen for changes to a specific keyringId's envelope. The callback
   * fires synchronously after every successful local `updateMe` /
   * `setMe` for that principal.
   *
   * Cross-instance changes (a teammate edits their profile on their
   * device, the sync engine pulls the diff onto this device) will fire
   * subscribers when the sync layer replays the write through this API.
   * In v1, subscribers do NOT fire on raw store changes — wire your sync
   * layer to call back through `vault.user.setMe` / `updateMe` if you
   * need that.
   *
   * Pass keyringId `'*'` to fire on every change in the vault.
   */
  subscribe<T = unknown>(
    keyringId: string,
    cb: (env: UserEnvelope<T> | null) => void,
  ): Unsubscribe {
    let listeners = this.listeners.get(keyringId)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(keyringId, listeners)
    }
    const wrapped: ChangeListener = cb as ChangeListener
    listeners.add(wrapped)
    return () => {
      listeners?.delete(wrapped)
      if (listeners && listeners.size === 0) {
        this.listeners.delete(keyringId)
      }
    }
  }

  /**
   * Reactive handle that caches the current value and re-reads on every
   * change for the given keyringId. Convenient for framework bindings:
   *
   *   const live = vault.user.live<UserShape>(vault.userId)
   *   live.subscribe(env => render(env?.data))
   *
   * Initial value is `null` until the first `current()` call materializes
   * it via `vault.user.get()`. Call `stop()` when done to release the
   * subscription.
   */
  live<T = unknown>(keyringId: string): LiveUserEnvelope<T> {
    let value: UserEnvelope<T> | null = null
    let primed = false
    const unsubscribe = this.subscribe<T>(keyringId, (env) => {
      value = env
    })

    return {
      current(): UserEnvelope<T> | null {
        if (!primed) {
          primed = true
          // First call: kick off a read but return synchronously. The
          // subscriber will be re-fired by the next write or the caller
          // can await `vault.user.get()` directly for an immediate read.
        }
        return value
      },
      subscribe: (cb) => this.subscribe<T>(keyringId, cb),
      stop: unsubscribe,
    }
  }

  // ─── Internal: change emission ───────────────────────────────────────

  private fireChange<T>(keyringId: string, env: UserEnvelope<T> | null): void {
    const targeted = this.listeners.get(keyringId)
    if (targeted) for (const l of targeted) l(env)
    const wildcard = this.listeners.get('*')
    if (wildcard) for (const l of wildcard) l(env)
  }
}

/**
 * Recursive plain-object deep merge with delete intent (#57).
 *
 * Patch semantics:
 *   - `undefined` — skip the key; source value preserved
 *   - `null` — delete the key from output (lodash `_.merge` /
 *     Firestore `FieldValue.delete()` semantics)
 *   - plain object — recurse (deep merge)
 *   - any other value — replace (arrays are replaced, not concatenated)
 *
 * Safe against the JS quirk where an own property explicitly set to
 * `undefined` is iterated by `Object.entries`. We dispatch on the value
 * BEFORE writing, so `{ k: undefined }` triggers the skip branch rather
 * than overwriting `out[k]` with undefined.
 */
function deepMerge<T>(source: T, patch: DeepPartialOrNull<T>): T {
  if (!isPlainObject(source) || !isPlainObject(patch)) {
    // Top-level non-object replace. `null` patch at the leaf level
    // would have been caught by the parent recursion's branch table;
    // at the top level it means "set the whole envelope to null,"
    // which the type system already prevents (T extends object).
    return patch as unknown as T
  }
  const out: Record<string, unknown> = { ...(source as Record<string, unknown>) }
  for (const [key, patchVal] of Object.entries(patch as Record<string, unknown>)) {
    if (patchVal === undefined) {
      // Skip — preserve the source value at this key. Matches the
      // pre-#57 behavior so callers who never used `null` see no diff.
      continue
    }
    if (patchVal === null) {
      // Delete intent. `delete` rather than `out[key] = undefined`
      // because JSON.stringify drops undefined fields silently and
      // we want the deletion to be visible to consumers iterating
      // the merged object (e.g. `Object.keys(merged.profile)`).
      delete out[key]
      continue
    }
    const sourceVal = (source as Record<string, unknown>)[key]
    if (isPlainObject(patchVal)) {
      // Recurse for any plain-object patch — including the "source is
      // missing this key" case. Without recursing through a synthetic
      // empty source, nested `null` deletions in the patch would land
      // as literal `null` values instead of triggering the delete
      // branch (e.g. `{ app: { signature: null } }` against a missing
      // `app` would emit `{ app: { signature: null } }` instead of
      // `{ app: {} }`).
      const recurseSource = isPlainObject(sourceVal) ? sourceVal : {}
      out[key] = deepMerge(recurseSource, patchVal as DeepPartialOrNull<typeof recurseSource>)
    } else {
      out[key] = patchVal
    }
  }
  return out as T
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object') return false
  if (Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x) as object | null
  return proto === Object.prototype || proto === null
}
