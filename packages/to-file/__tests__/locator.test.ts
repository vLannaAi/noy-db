import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStoreLocator } from '@noy-db/hub/to'
import type { StoreDescriptor } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerFileStore, fileStoreDescriptor } from '../src/index.js'

describe('to-file store-locator descriptor', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerFileStore(locator)

    const dir = await mkdtemp(join(tmpdir(), 'noydb-locator-test-'))
    try {
      const descriptor = fileStoreDescriptor(dir)
      const store = await locator.resolve(descriptor)

      expect(await store.ping()).toBe(true)
      await store.put('vault1', 'coll1', 'id1', {
        _noydb: 1,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: 'dGVzdC1pdi0xMjM0',
        _data: Buffer.from('hello').toString('base64'),
      })
      const got = await store.get('vault1', 'coll1', 'id1')
      expect(got?._v).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('descriptor is JSON-serializable, credentialless, and has no function-valued field', () => {
    const descriptor = fileStoreDescriptor('/some/path')

    // Round-trips through JSON without loss.
    const roundTripped = JSON.parse(JSON.stringify(descriptor))
    expect(roundTripped).toEqual(descriptor)

    // No field is function-valued (i.e. no credential source, no factory).
    for (const value of Object.values(descriptor)) {
      expect(typeof value).not.toBe('function')
    }
    const address = descriptor.address as Record<string, unknown>
    for (const value of Object.values(address)) {
      expect(typeof value).not.toBe('function')
    }

    expect(descriptor.kind).toBe('file')
    expect(descriptor.class).toBe('local')
  })

  it('unknown kind throws a typed error', () => {
    const locator = createStoreLocator()
    registerFileStore(locator)

    const badDescriptor: StoreDescriptor = { kind: 'not-a-real-kind', class: 'local', address: {} }
    expect(() => locator.resolve(badDescriptor)).toThrow()
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
//
// A fresh descriptor (unique tmp dir) is resolved per test via a fresh
// locator, proving the descriptor-constructed store passes the same
// 6-method contract as `toFile()` itself.

let locatorTestDirs: string[] = []

runStoreConformanceTests(
  'toFile (via store-locator descriptor)',
  async () => {
    const locator = createStoreLocator()
    registerFileStore(locator)
    const dir = await mkdtemp(join(tmpdir(), 'noydb-locator-conformance-'))
    locatorTestDirs.push(dir)
    return locator.resolve(fileStoreDescriptor(dir))
  },
  async () => {
    for (const dir of locatorTestDirs) {
      await rm(dir, { recursive: true, force: true })
    }
    locatorTestDirs = []
  },
)
