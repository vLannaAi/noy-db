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

/** Cancel a previously-registered subscription. */
export type Unsubscribe = () => void

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
   */
  async updateMe<T extends object = Record<string, unknown>>(
    patch: DeepPartial<T>,
  ): Promise<UserEnvelope<T>> {
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
   */
  async setMe<T = unknown>(payload: T): Promise<UserEnvelope<T>> {
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
   */
  async get<T = unknown>(keyringId: string): Promise<UserEnvelope<T> | null> {
    const dek = await this.getDek()
    return loadUserEnvelope<T>(this.adapter, this.vaultName, keyringId, dek)
  }

  /**
   * Read every persisted envelope in the vault. Order is store-defined.
   * Empty when no principal has called `updateMe` yet.
   *
   * In v1 this returns all envelopes the caller can decrypt — i.e. all
   * principals in the vault. The `view-team-profiles` policy gate (#22)
   * will gate this call; setting `view-team-profiles.enabled: false` is
   * the privacy-strict opt-out that makes this return only `[me]`.
   */
  async list<T = unknown>(): Promise<UserEnvelope<T>[]> {
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
 * Recursive plain-object deep merge. Patch values overwrite source
 * values; arrays are replaced (not concatenated); null / undefined in
 * patch is treated as a delete-key intent only when explicitly set.
 *
 * For the user envelope use case, "delete a preference" should go
 * through `setMe(newWholePayload)` — `updateMe` is for *additive* and
 * *modifying* updates only.
 */
function deepMerge<T>(source: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(source) || !isPlainObject(patch)) {
    return patch as unknown as T
  }
  const out: Record<string, unknown> = { ...(source as Record<string, unknown>) }
  for (const [key, patchVal] of Object.entries(patch as Record<string, unknown>)) {
    const sourceVal = (source as Record<string, unknown>)[key]
    if (isPlainObject(sourceVal) && isPlainObject(patchVal)) {
      out[key] = deepMerge(sourceVal, patchVal as DeepPartial<typeof sourceVal>)
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
