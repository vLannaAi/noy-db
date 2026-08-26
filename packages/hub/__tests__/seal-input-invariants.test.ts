import { describe, it, expect } from 'vitest'
import { buildRecordAad } from '../src/kernel/enclave/record-aad.js'
import type { RecordIdentity } from '../src/kernel/enclave/record-aad.js'

/**
 * Output-domain invariants on what may reach a seal (#1220).
 *
 * Both assertions fire only for a caller the compiler never saw — a JS
 * consumer, a hand-built fixture, a widened `Partial`. That is the point:
 * TypeScript already rejects these calls, so the runtime check exists for
 * the consumer who is not running it. Sibling of the `version` assertion
 * already in `buildRecordAad`, and filed for the same reason — a value that
 * coerces silently produces a record no reader can open, and the failure
 * surfaces later on the READ path where the code is correct.
 */
describe('seal input invariants (#1220)', () => {
  const ok: RecordIdentity = { collection: 'docs', id: 'd1', version: 1 }

  it('accepts a well-formed identity', () => {
    expect(() => buildRecordAad(ok)).not.toThrow()
  })

  it('refuses a non-string id rather than coercing it', () => {
    // `put({id:'d1'}, …)` from JS lands here with an OBJECT as the id.
    // `String({})` is `"[object Object]"` — a perfectly good AAD field, so
    // without this the record seals happily under a key nobody queries.
    const bad = { ...ok, id: { id: 'd1' } } as unknown as RecordIdentity
    expect(() => buildRecordAad(bad)).toThrow(TypeError)
    expect(() => buildRecordAad(bad)).toThrow(/id must be a string/)
  })

  it('refuses an absent id — the unset-identity case', () => {
    // `createNoydb({ userId })` (not an option) leaves identity unset, and
    // `undefined` reaches the store as a record id.
    const bad = { ...ok, id: undefined } as unknown as RecordIdentity
    expect(() => buildRecordAad(bad)).toThrow(/id must be a string/)
  })

  it('refuses a non-string collection rather than coercing it', () => {
    const bad = { ...ok, collection: 42 } as unknown as RecordIdentity
    expect(() => buildRecordAad(bad)).toThrow(/collection must be a string/)
  })

  it('names the offending value in the message', () => {
    const bad = { ...ok, id: 42 } as unknown as RecordIdentity
    expect(() => buildRecordAad(bad)).toThrow(/42/)
  })
})

describe('no envelope may be sealed over a non-string plaintext (#1220)', () => {
  const open = async () => {
    const { createNoydb } = await import('../src/index.js')
    const db = await createNoydb({ secret: 'x'.repeat(32), user: 'owner' })
    const vault = await db.openVault('v1', { create: true })
    return vault.collection<{ title?: string }>('docs')
  }

  it('stores and reads back a well-formed record', async () => {
    const docs = await open()
    await docs.put('d1', { title: 'hello' })
    expect(await docs.get('d1')).toEqual({ title: 'hello' })
  })

  it('refuses an undefined record instead of sealing empty plaintext', async () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string, so the seal
    // runs over nothing: `_data` becomes a 16-byte GCM tag with zero
    // ciphertext. The record then reads back as `null` on the cached path and
    // throws `SyntaxError` out of `decryptRecord` on the hydrate path — two
    // failures that both point away from the actual cause.
    const docs = await open()
    await expect(docs.put('d1', undefined as unknown as { title: string }))
      .rejects.toThrow(TypeError)
  })

  it('leaves nothing behind when it refuses', async () => {
    const docs = await open()
    await docs.put('keep', { title: 'kept' })
    await expect(docs.put('bad', undefined as unknown as { title: string })).rejects.toThrow()
    expect(await docs.count()).toBe(1)
    expect(await docs.get('keep')).toEqual({ title: 'kept' })
  })
})

describe('the reported call fails loudly (#1220 regression)', () => {
  it('refuses put(record) — the two-argument signature called with one', async () => {
    // Exactly what was reported, twice, from two repos:
    //   c.put({ id: 'd1', title: 'hello' })
    // The object became the KEY and the record was `undefined`. Before this
    // guard the write SUCCEEDED and `count()` returned 1 while `get('d1')`
    // returned null — the degraded state rendered as a healthy one.
    const { createNoydb } = await import('../src/index.js')
    const db = await createNoydb({ secret: 'x'.repeat(32), user: 'owner' })
    const vault = await db.openVault('v1', { create: true })
    const docs = vault.collection<{ title: string }>('docs')

    await expect(
      (docs as unknown as { put(r: unknown): Promise<void> }).put({ id: 'd1', title: 'hello' }),
    ).rejects.toThrow(TypeError)

    expect(await docs.count()).toBe(0)
  })
})
