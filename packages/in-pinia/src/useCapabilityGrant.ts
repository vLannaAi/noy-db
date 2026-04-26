/**
 * `useCapabilityGrant` — Vue/Pinia composable for time-boxed
 * capability approval flows (#282).
 *
 * The composable orchestrates a request → approve → expire / release
 * lifecycle for a session-scoped capability. It manages UI state,
 * persists the request to a reserved `_capability_requests` collection
 * so a separate approver session can see it, and tracks TTL with
 * auto-revert.
 *
 * **It does NOT itself flip capability bits.** Capability mechanisms
 * vary across adopters: tier-based deployments wire `onGrant` to
 * `vault.elevate(tier, opts)`; keyring-based deployments wire it to
 * `db.grant(...)`; custom deployments do their own thing. Keeping the
 * actual flip behind a callback avoids introducing a parallel
 * "capability elevation" primitive in hub when the existing
 * `vault.elevate()` already covers the time-boxed-grant pattern.
 *
 * ## State machine
 *
 *   idle  ─── .request() ───────►  requested
 *   requested  ─── .approve() ──►  granted
 *   granted    ─── TTL expires ─►  idle
 *   granted    ─── .release() ──►  idle
 *
 * @module
 */

import {
  computed,
  getCurrentScope,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import type { Vault, Role, CollectionChangeEvent } from '@noy-db/hub'
import { resolveNoydb } from './context.js'

/** Reserved internal collection that holds capability-grant lifecycle records. */
export const CAPABILITY_REQUESTS_COLLECTION = '_capability_requests'

export type CapabilityGrantState = 'idle' | 'requested' | 'granted' | 'expired'

/**
 * On-disk shape of a capability-grant lifecycle record. Persisted in
 * the reserved {@link CAPABILITY_REQUESTS_COLLECTION}. Encrypted with
 * that collection's DEK at the storage layer; the in-memory shape
 * here is plaintext.
 *
 * The audit trail invariant: this record carries metadata only —
 * capability name, roles, ttl, reason. Never plaintext payload.
 */
export interface CapabilityGrantRecord {
  readonly id: string
  readonly capability: string
  readonly requestedBy: string
  readonly approverRole: Role
  readonly reason: string
  readonly ttlMs: number
  readonly status: 'requested' | 'granted' | 'released' | 'expired'
  readonly requestedAt: string
  readonly approvedBy?: string
  readonly approvedAt?: string
  readonly expiresAt?: string
}

export interface UseCapabilityGrantOptions {
  /** TTL in milliseconds for the granted window. */
  readonly ttlMs: number
  /** Role required to call `.approve()`. Mismatch throws on `.approve()`. */
  readonly approver: Role
  /** Audit-ledger string. Stamped on the request record; no plaintext payload. */
  readonly reason: string
  /**
   * Optional explicit vault. Either a `Vault` instance or its name.
   * When omitted, resolves the active Noydb instance via
   * `setActiveNoydb()` and opens the first vault the caller has
   * already loaded.
   */
  readonly vault: Vault | string
  /**
   * Called on the approver's session when `.approve()` succeeds. Wire
   * this to whatever capability flip your codebase uses —
   * `vault.elevate(tier, opts)` for tier-based deployments,
   * `db.grant(...)` for keyring-based, custom for custom.
   *
   * The composable does NOT enforce that the capability was actually
   * granted — it just tracks the lifecycle. The post-expiry "gated
   * call throws" contract comes from the underlying mechanism the
   * callback wires up (e.g., `ElevationExpiredError` from
   * `vault.elevate`'s lazy TTL check).
   */
  readonly onGrant?: (ctx: {
    record: CapabilityGrantRecord
    vault: Vault
  }) => void | Promise<void>
  /**
   * Called when the grant ends (TTL expiry OR voluntary release).
   * Mirror of `onGrant`. Idempotent — may be called twice if release
   * and expiry race; callers should no-op on the second invocation.
   */
  readonly onRelease?: (ctx: {
    record: CapabilityGrantRecord
    vault: Vault
    cause: 'released' | 'expired'
  }) => void | Promise<void>
}

export interface UseCapabilityGrantReturn {
  readonly state: Ref<CapabilityGrantState>
  /** Milliseconds remaining on the granted window; 0 outside `granted`. */
  readonly timeRemaining: ComputedRef<number>
  /** Most recent error from request/approve/release (resets on next op). */
  readonly error: Ref<Error | null>
  /** Issue a request. State must be `idle`. */
  request(): Promise<void>
  /** Approve a pending request. State must be `requested`. */
  approve(): Promise<void>
  /** Voluntarily revoke an active grant. State must be `granted`. */
  release(): Promise<void>
}

/**
 * Build a reactive capability-grant lifecycle handle.
 *
 * @example Tier-based capability flip
 * ```ts
 * let elevated: ElevatedHandle | null = null
 * const grant = useCapabilityGrant('canExportPlaintext', {
 *   vault: 'V1',
 *   ttlMs: 15 * 60_000,
 *   approver: 'admin',
 *   reason: 'bulk export',
 *   onGrant: async ({ vault, record }) => {
 *     elevated = await vault.elevate(2, {
 *       ttlMs: record.ttlMs,
 *       reason: record.reason,
 *     })
 *   },
 *   onRelease: async () => { await elevated?.release(); elevated = null },
 * })
 * ```
 */
export function useCapabilityGrant(
  capability: string,
  options: UseCapabilityGrantOptions,
): UseCapabilityGrantReturn {
  const state = ref<CapabilityGrantState>('idle')
  const error = ref<Error | null>(null)
  const recordRef = shallowRef<CapabilityGrantRecord | null>(null)

  // SSR / non-browser host: composable is a no-op. Methods reject; the
  // refs stay at their initial values so server-rendered output shows
  // the idle state.
  const inBrowser = typeof window !== 'undefined'

  let expiryTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribeChangeStream: (() => void) | null = null
  let resolvedVault: Vault | null = null
  let stopped = false

  async function resolveVault(): Promise<Vault> {
    if (resolvedVault) return resolvedVault
    if (typeof options.vault === 'string') {
      const noydb = resolveNoydb(null)
      resolvedVault = await noydb.openVault(options.vault)
    } else {
      resolvedVault = options.vault
    }
    // Open the requests collection eagerly so the change stream
    // subscription below has a target. We don't typed-cast here —
    // the collection holds CapabilityGrantRecord shapes only.
    resolvedVault.collection<CapabilityGrantRecord>(
      CAPABILITY_REQUESTS_COLLECTION,
    )
    return resolvedVault
  }

  function clearExpiryTimer(): void {
    if (expiryTimer) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
  }

  function scheduleExpiry(record: CapabilityGrantRecord): void {
    if (!record.expiresAt) return
    const remaining = new Date(record.expiresAt).getTime() - Date.now()
    if (remaining <= 0) {
      void handleExpiry(record)
      return
    }
    clearExpiryTimer()
    expiryTimer = setTimeout(() => { void handleExpiry(record) }, remaining)
  }

  async function handleExpiry(record: CapabilityGrantRecord): Promise<void> {
    if (stopped) return
    if (state.value !== 'granted') return
    state.value = 'expired'
    try {
      await options.onRelease?.({
        record,
        vault: resolvedVault!,
        cause: 'expired',
      })
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
    }
    // Auto-return to idle after the expiry handler — matches the spec's
    // "state auto-returns to idle" contract.
    state.value = 'idle'
    recordRef.value = null
  }

  // `now` ticks every second so timeRemaining stays reactive without
  // wiring a per-frame loop.
  const now = ref(Date.now())
  const tickTimer = inBrowser
    ? setInterval(() => { now.value = Date.now() }, 1000)
    : null

  const timeRemaining = computed(() => {
    if (state.value !== 'granted' || !recordRef.value?.expiresAt) return 0
    // Subscribe to `now` for reactivity, but read the live clock for
    // accuracy — `now` ticks every second so the computed stays
    // honest between ticks too.
    void now.value
    const ms = new Date(recordRef.value.expiresAt).getTime() - Date.now()
    return ms > 0 ? ms : 0
  })

  // Subscribe to the requests collection so an approver session sees
  // pending records appear in real time within the same Noydb session.
  // Cross-session visibility additionally requires the sync engine.
  watch(
    () => recordRef.value?.id,
    async (id) => {
      if (!inBrowser || !id || unsubscribeChangeStream) return
      const vault = await resolveVault()
      const coll = vault.collection<CapabilityGrantRecord>(
        CAPABILITY_REQUESTS_COLLECTION,
      )
      unsubscribeChangeStream = coll.subscribe(
        (evt: CollectionChangeEvent<CapabilityGrantRecord>) => {
          if (evt.type !== 'put' || evt.id !== id) return
          const updated = evt.record
          if (!updated || stopped) return
          recordRef.value = updated
          if (updated.status === 'granted') {
            state.value = 'granted'
            scheduleExpiry(updated)
          } else if (updated.status === 'released' || updated.status === 'expired') {
            state.value = 'idle'
            clearExpiryTimer()
          }
        },
      )
    },
    { immediate: false },
  )

  async function request(): Promise<void> {
    if (state.value !== 'idle') {
      error.value = new Error(
        `useCapabilityGrant: cannot request from state "${state.value}"`,
      )
      throw error.value
    }
    error.value = null
    if (!inBrowser) return
    try {
      const vault = await resolveVault()
      const coll = vault.collection<CapabilityGrantRecord>(
        CAPABILITY_REQUESTS_COLLECTION,
      )
      const id = `cap-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
      const record: CapabilityGrantRecord = {
        id,
        capability,
        requestedBy: vault.userId,
        approverRole: options.approver,
        reason: options.reason,
        ttlMs: options.ttlMs,
        status: 'requested',
        requestedAt: new Date().toISOString(),
      }
      await coll.put(id, record)
      recordRef.value = record
      state.value = 'requested'
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      throw error.value
    }
  }

  async function approve(): Promise<void> {
    const record = recordRef.value
    if (state.value !== 'requested' || !record) {
      error.value = new Error(
        `useCapabilityGrant: cannot approve from state "${state.value}"`,
      )
      throw error.value
    }
    error.value = null
    try {
      const vault = await resolveVault()
      if (vault.role !== options.approver && vault.role !== 'owner') {
        throw new Error(
          `useCapabilityGrant: caller role "${vault.role}" cannot approve a "${options.approver}"-tier grant`,
        )
      }
      const approvedAt = new Date()
      const expiresAt = new Date(approvedAt.getTime() + options.ttlMs)
      const granted: CapabilityGrantRecord = {
        ...record,
        status: 'granted',
        approvedBy: vault.userId,
        approvedAt: approvedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }
      const coll = vault.collection<CapabilityGrantRecord>(
        CAPABILITY_REQUESTS_COLLECTION,
      )
      await coll.put(record.id, granted)
      recordRef.value = granted
      state.value = 'granted'
      scheduleExpiry(granted)
      await options.onGrant?.({ record: granted, vault })
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      throw error.value
    }
  }

  async function release(): Promise<void> {
    const record = recordRef.value
    if (state.value !== 'granted' || !record) {
      // Releasing from non-granted state is a no-op.
      return
    }
    error.value = null
    try {
      clearExpiryTimer()
      const vault = await resolveVault()
      const released: CapabilityGrantRecord = { ...record, status: 'released' }
      const coll = vault.collection<CapabilityGrantRecord>(
        CAPABILITY_REQUESTS_COLLECTION,
      )
      await coll.put(record.id, released)
      recordRef.value = null
      state.value = 'idle'
      await options.onRelease?.({ record, vault, cause: 'released' })
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      throw error.value
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      stopped = true
      clearExpiryTimer()
      if (tickTimer) clearInterval(tickTimer)
      unsubscribeChangeStream?.()
    })
  }

  return { state, timeRemaining, error, request, approve, release }
}
