/**
 * Search/retrieve existence post-filter for satellite collections (#591, Task 9).
 *
 * Spec: docs/superpowers/specs/2026-07-05-satellite-collections-design.md
 *
 * `vault.collection(satelliteName)` returns an existence-filtering proxy
 * (`with-shape/satellites/proxy.ts`) for `get`/`list`/`put`, but the search
 * facade (`with-lookup/search/collection-facade.ts`) answers `search()` /
 * `retrieve()` / `similarTo()` straight out of its own lexical index /
 * eager cache — neither of those read paths ever consulted the satellite's
 * proxy, so a satellite row whose paired base was raw-deleted or tombstoned
 * stayed findable. This suite proves the proxy now also existence-filters
 * those three retrieval surfaces, that a non-satellite collection is
 * byte-identically unaffected, and that the filter is a pure read-side
 * post-filter — it never touches the persisted `_ftindex` posting.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/with-lookup/search/index.js'
import { toMemory } from '../../to-memory/src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

const SECRET = 'satellites-search-filter-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  subject?: string
  body?: string
}

async function openPair() {
  const rawStore = toMemory()
  const db = await createNoydb({
    store: rawStore,
    user: 'alice',
    secret: SECRET,
    searchStrategy: withSearch(),
  })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs')
  vault.collection<Msg>('msgs_text', {
    satelliteOf: 'msgs',
    fields: ['subject', 'body'],
    joined: 'msgs_full',
    textIndexes: ['body'],
    textIndexPersist: true,
  })
  return { vault, rawStore }
}

async function tombstone(rawStore: NoydbStore, vault: string, collection: string, id: string): Promise<void> {
  const live = await rawStore.get(vault, collection, id)
  if (!live) throw new Error('tombstone: no live envelope to forge')
  await rawStore.put(vault, collection, id, { ...(live as EncryptedEnvelope), _iv: '', _data: '' })
}

describe('satellite search/retrieve existence post-filter (#591, Task 9)', () => {
  it('retrieve() drops a satellite hit whose base was raw-deleted; the _ftindex posting physically remains', async () => {
    const { vault, rawStore } = await openPair()
    await vault.joined('msgs_full').put('x', { from: 'a', body: 'zebra unique' })

    // Sanity + force the persisted index to build/save while the base is live.
    const before = await vault.collection('msgs_text').retrieve('zebra')
    expect(before.map((h) => h.id)).toEqual(['x'])
    const ftBefore = await rawStore.get('v1', '_ftindex', 'msgs_text')
    expect(ftBefore).not.toBeNull()

    await rawStore.delete('v1', 'msgs', 'x')

    const hits = await vault.collection('msgs_text').retrieve('zebra')
    expect(hits).toEqual([])

    const ftAfter = await rawStore.get('v1', '_ftindex', 'msgs_text')
    expect(ftAfter).toEqual(ftBefore) // posting untouched — a pure read-side filter
  })

  it('retrieve() drops a satellite hit whose base is tombstoned (not merely absent)', async () => {
    const { vault, rawStore } = await openPair()
    await vault.joined('msgs_full').put('y', { from: 'a', body: 'walrus unique' })
    await vault.collection('msgs_text').retrieve('walrus') // build/persist while live

    await tombstone(rawStore, 'v1', 'msgs', 'y')

    const hits = await vault.collection('msgs_text').retrieve('walrus')
    expect(hits).toEqual([])
  })

  it('search() (scan mode) also drops a satellite hit whose base was raw-deleted', async () => {
    const { vault, rawStore } = await openPair()
    await vault.joined('msgs_full').put('z', { from: 'a', body: 'quokka unique' })

    await rawStore.delete('v1', 'msgs', 'z')

    const hits = await vault.collection('msgs_text').search('body', 'quokka')
    expect(hits).toEqual([])
  })

  it('does not affect a non-satellite collection\'s retrieve() (byte-identical behavior)', async () => {
    const { vault } = await openPair()
    const docs = vault.collection<{ title: string }>('docs', { textIndexes: ['title'] })
    await docs.put('d1', { title: 'penguin waddle' })
    await docs.put('d2', { title: 'penguin march' })

    const hits = await docs.retrieve('penguin')
    expect(hits.map((h) => h.id).sort()).toEqual(['d1', 'd2'])
  })
})

describe('satellite deterministic-lookup existence filter (#591, Task 9 review fix)', () => {
  async function openDetPair() {
    const rawStore = toMemory()
    const db = await createNoydb({ store: rawStore, user: 'alice', secret: SECRET })
    const vault = await db.openVault('v1')
    vault.collection<Msg>('msgs')
    vault.collection<Msg>('msgs_text', {
      satelliteOf: 'msgs',
      fields: ['subject', 'body'],
      joined: 'msgs_full',
      deterministicFields: ['body'],
      acknowledgeDeterministicRisk: true,
    })
    return { vault, rawStore }
  }

  it('findByDet skips a dead-base match and still finds a later live one', async () => {
    const { vault, rawStore } = await openDetPair()
    // Same det value on both pairs; both rows carry an identical _det slot.
    await vault.joined('msgs_full').put('a', { from: 'x', subject: 'dead', body: 'shared-det' })
    await vault.joined('msgs_full').put('b', { from: 'y', subject: 'live', body: 'shared-det' })

    await rawStore.delete('v1', 'msgs', 'a')

    const found = await vault.collection<Msg>('msgs_text').findByDet('body', 'shared-det')
    expect(found).toMatchObject({ subject: 'live', body: 'shared-det' })
    // And once the second base dies too, the match is fully gone.
    await rawStore.delete('v1', 'msgs', 'b')
    expect(await vault.collection<Msg>('msgs_text').findByDet('body', 'shared-det')).toBeNull()
  })

  it('findByDet returns null when the only match\'s base is tombstoned', async () => {
    const { vault, rawStore } = await openDetPair()
    await vault.joined('msgs_full').put('x', { from: 'a', body: 'lonely-det' })

    await tombstone(rawStore, 'v1', 'msgs', 'x')

    expect(await vault.collection<Msg>('msgs_text').findByDet('body', 'lonely-det')).toBeNull()
  })

  it('queryByDet excludes dead-base matches and keeps live ones', async () => {
    const { vault, rawStore } = await openDetPair()
    await vault.joined('msgs_full').put('a', { from: 'x', subject: 'keep', body: 'multi-det' })
    await vault.joined('msgs_full').put('b', { from: 'y', subject: 'drop', body: 'multi-det' })

    await rawStore.delete('v1', 'msgs', 'b')

    const hits = await vault.collection<Msg>('msgs_text').queryByDet('body', 'multi-det')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ subject: 'keep', body: 'multi-det' })
  })

  it('does not affect a non-satellite collection\'s det lookups', async () => {
    const { vault } = await openDetPair()
    const users = vault.collection<{ email: string }>('users', {
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })
    await users.put('u1', { email: 'a@x' })
    await users.put('u2', { email: 'a@x' })

    expect(await users.findByDet('email', 'a@x')).not.toBeNull()
    expect(await users.queryByDet('email', 'a@x')).toHaveLength(2)
  })
})
