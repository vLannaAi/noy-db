import { describe, it, expect } from 'vitest'
import * as kernel from '../src/kernel/index.js'
// Type-only smoke: fails to compile if any of these types stop being exported.
import type {
  ChangeEvent, Vault, Collection, Noydb, Operator, Query, JoinStrategy,
  LiveQuery, AggregateResult, AggregateSpec, LiveAggregation, IndexDef,
} from '../src/kernel/index.js'

describe('@noy-db/hub/kernel surface', () => {
  it('exposes the runtime kernel functions federation needs', () => {
    expect(typeof kernel.readPath).toBe('function')
    expect(typeof kernel.reduceRecords).toBe('function')
    expect(typeof kernel.groupAndReduce).toBe('function')
    expect(typeof kernel.generateULID).toBe('function')
    expect(typeof kernel.sha256Hex).toBe('function')
  })

  it('exposes the federation error classes', () => {
    const names = [
      'CrossShardJoinError', 'DataResidencyError', 'NoAccessError',
      'ReservedVaultNameError', 'ShardProvisioningError', 'UnknownShardError',
      'ValidationError', 'VaultTemplateNotFoundError',
    ] as const
    for (const n of names) {
      expect(typeof (kernel as Record<string, unknown>)[n]).toBe('function')
    }
  })

  it('generateULID returns a 26-char Crockford ULID', () => {
    expect(kernel.generateULID()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})

// Compile-time assertion that the type surface is present (no runtime cost).
type _TypeSurface = [
  ChangeEvent, Vault, Collection, Noydb, Operator, Query, JoinStrategy,
  LiveQuery, AggregateResult, AggregateSpec, LiveAggregation, IndexDef,
]
