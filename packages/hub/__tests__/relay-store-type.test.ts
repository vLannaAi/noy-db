// #1237 — `NoydbRelayStore`: the relay profile expressed in the TYPE layer.
//
// The property under test is a COMPILE-TIME one, so these are type-level
// assertions that fail the build rather than runtime expectations. A runtime
// test cannot see the thing that matters: that a handler typed against this
// cannot compile a call to `saveAll`.
import { describe, it, expect } from 'vitest'
import type { NoydbStore, NoydbRelayStore, EncryptedEnvelope } from '../src/port/to/index.js'

describe('#1237 — NoydbRelayStore narrows in the type layer only', () => {
  it('a FULL NoydbStore satisfies the relay type — relaying an ordinary store needs no changes', () => {
    const full: NoydbStore = {
      async get() { return null },
      async put() {},
      async delete() {},
      async list() { return [] },
      async loadAll() { return {} },
      async saveAll() {},
    }
    const relayed: NoydbRelayStore = full   // structural: extra members are fine
    expect(typeof relayed.get).toBe('function')
  })

  it('an object WITHOUT saveAll satisfies it — the profile is expressible', () => {
    const narrowed: NoydbRelayStore = {
      async get() { return null },
      async put() {},
      async delete() {},
      async list() { return [] },
      async loadAll() { return {} },
    }
    expect(typeof narrowed.get).toBe('function')
    // @ts-expect-error — saveAll is not a member of the relay profile. THIS is
    // the assertion: a relay handler typed against NoydbRelayStore cannot
    // compile a call to saveAll, so no mis-set `allow` can reach it.
    expect(narrowed.saveAll).toBeUndefined()
  })

  it('listVaults is likewise absent from the profile', () => {
    const narrowed = {} as NoydbRelayStore
    // @ts-expect-error — enumeration is an existence leak; omitted by profile.
    expect(narrowed.listVaults).toBeUndefined()
  })

  it('the RUNTIME contract is untouched — a full store still has both members', () => {
    // The boundary #1211's design names as its single falsifier: NoydbStore
    // itself must not change. If this ever fails, the conformance kit's
    // store-observation design has to be re-opened, not patched here.
    const full = {
      async get() { return null }, async put() {}, async delete() {},
      async list() { return [] }, async loadAll() { return {} }, async saveAll() {},
    } satisfies NoydbStore
    expect(typeof full.saveAll).toBe('function')
    const _envelopeStillExported: EncryptedEnvelope | null = null
    expect(_envelopeStillExported).toBeNull()
  })
})
