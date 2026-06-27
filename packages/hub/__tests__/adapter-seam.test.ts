import { describe, it, expect } from 'vitest'
import { ConflictError, NetworkError, StoreCapabilityError } from '@noy-db/hub/adapter'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  StoreCapabilities,
  StoreTime,
  ListPageResult,
} from '@noy-db/hub/adapter'

describe('@noy-db/hub/adapter seam', () => {
  it('re-exports the store-facing error classes as constructable runtime values', () => {
    const conflict = new ConflictError(7)
    expect(conflict).toBeInstanceOf(ConflictError)
    expect(conflict.version).toBe(7)
    expect(new NetworkError()).toBeInstanceOf(NetworkError)
    expect(new StoreCapabilityError('listVaults', 'openVault')).toBeInstanceOf(StoreCapabilityError)
  })

  it('re-exports the store contract types (compile-time only)', () => {
    // type-only smoke: these must resolve at typecheck; runtime is a no-op
    const env = null as EncryptedEnvelope | null
    const store = null as unknown as NoydbStore
    const snap = null as unknown as VaultSnapshot
    const ops = null as unknown as readonly TxOp[]
    const caps = null as unknown as StoreCapabilities
    const time = null as unknown as StoreTime
    const page = null as unknown as ListPageResult
    expect([env, store, snap, ops, caps, time, page].every(v => v === null)).toBe(true)
  })
})
