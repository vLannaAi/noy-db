/**
 * Reader-side coverage for @noy-db/as-blob.
 *
 * Covers:
 *   - capability gate: `assertCanImport('plaintext', 'blob')`
 *   - status: 'added' (slot empty) vs 'modified' (slot already populated)
 *   - policy: 'replace' overwrites, 'insert-only' refuses on populated slot
 *   - missing target record → typed error
 *   - round-trip: write blob → fromBytes new bytes → toBytes returns new bytes
 */
import { describe, expect, it } from 'vitest'
import { ImportCapabilityError, createNoydb } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { toMemory } from '@noy-db/to-memory'
import { fromBytes, toBytes } from '../src/index.js'
import { withTeam } from '@noy-db/hub/team'

interface Doc { title: string }

const ORIGINAL = new Uint8Array([0x01, 0x02, 0x03, 0x04])
const REPLACEMENT = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])

async function setup() {
  const adapter = toMemory()
  const init = await createNoydb({ teamStrategy: withTeam(),
    store: adapter, user: 'alice', secret: 'pw-2026',
    blobsStrategy: withBlobs(),
  })
  await init.openVault('demo')
  await init.grant('demo', {
    userId: 'alice', displayName: 'Alice', role: 'owner',
    secret: 'pw-2026',
    importCapability: { plaintext: ['blob'] },
    exportCapability: { plaintext: ['blob'] },  // round-trip needs export too
  })
  init.close()

  const db = await createNoydb({ teamStrategy: withTeam(),
    store: adapter, user: 'alice', secret: 'pw-2026',
    blobsStrategy: withBlobs(),
  })
  const vault = await db.openVault('demo')
  await vault.collection<Doc>('docs').put('d-1', { title: 'first' })
  return { db, adapter, vault }
}

describe('as-blob fromBytes — capability gate', () => {
  it('throws ImportCapabilityError when the keyring lacks the grant', async () => {
    const adapter = toMemory()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-2026', blobsStrategy: withBlobs() })
    const vault = await db.openVault('demo')
    await vault.collection<Doc>('docs').put('d-1', { title: 'first' })
    await expect(
      fromBytes(vault, ORIGINAL, { collection: 'docs', id: 'd-1' }),
    ).rejects.toThrow(ImportCapabilityError)
    db.close()
  })
})

describe('as-blob fromBytes — plan status', () => {
  it('reports status: "added" when the slot is empty', async () => {
    const { db, vault } = await setup()
    const plan = await fromBytes(vault, ORIGINAL, { collection: 'docs', id: 'd-1' })
    expect(plan.status).toBe('added')
    expect(plan.priorETag).toBeUndefined()
    expect(plan.slot).toBe('raw')
    expect(plan.bytes).toBe(ORIGINAL.byteLength)
    db.close()
  })

  it('reports status: "modified" when the slot is already populated', async () => {
    const { db, vault } = await setup()
    // First write
    const first = await fromBytes(vault, ORIGINAL, { collection: 'docs', id: 'd-1' })
    await first.apply()
    // Second write — same slot, different bytes
    const second = await fromBytes(vault, REPLACEMENT, { collection: 'docs', id: 'd-1' })
    expect(second.status).toBe('modified')
    expect(second.priorETag).toBeDefined()
    db.close()
  })
})

describe('as-blob fromBytes — policy', () => {
  it('"replace" (default) overwrites an existing slot', async () => {
    const { db, vault } = await setup()
    const first = await fromBytes(vault, ORIGINAL, { collection: 'docs', id: 'd-1' })
    await first.apply()
    const second = await fromBytes(vault, REPLACEMENT, { collection: 'docs', id: 'd-1' })
    await second.apply()

    const round = await toBytes(vault, { collection: 'docs', id: 'd-1' })
    expect(round.bytes).toEqual(REPLACEMENT)
    db.close()
  })

  it('"insert-only" refuses when the slot is already populated', async () => {
    const { db, vault } = await setup()
    const first = await fromBytes(vault, ORIGINAL, { collection: 'docs', id: 'd-1' })
    await first.apply()

    await expect(
      fromBytes(vault, REPLACEMENT, {
        collection: 'docs', id: 'd-1',
        policy: 'insert-only',
      }),
    ).rejects.toThrow(/insert-only refused/)
    db.close()
  })

  it('"insert-only" succeeds when the slot is empty', async () => {
    const { db, vault } = await setup()
    const plan = await fromBytes(vault, ORIGINAL, {
      collection: 'docs', id: 'd-1',
      policy: 'insert-only',
    })
    expect(plan.status).toBe('added')
    await plan.apply()
    const round = await toBytes(vault, { collection: 'docs', id: 'd-1' })
    expect(round.bytes).toEqual(ORIGINAL)
    db.close()
  })
})

describe('as-blob fromBytes — missing record', () => {
  it('refuses to attach to a non-existent record', async () => {
    const { db, vault } = await setup()
    await expect(
      fromBytes(vault, ORIGINAL, { collection: 'docs', id: 'does-not-exist' }),
    ).rejects.toThrow(/not found/)
    db.close()
  })
})

describe('as-blob fromBytes — round-trip', () => {
  it('write → fromBytes → toBytes equals the input bytes', async () => {
    const { db, vault } = await setup()
    const plan = await fromBytes(vault, ORIGINAL, {
      collection: 'docs', id: 'd-1',
      mimeType: 'application/octet-stream',
    })
    await plan.apply()

    const round = await toBytes(vault, { collection: 'docs', id: 'd-1' })
    expect(round.bytes).toEqual(ORIGINAL)
    expect(round.mime).toBe('application/octet-stream')
    db.close()
  })
})
