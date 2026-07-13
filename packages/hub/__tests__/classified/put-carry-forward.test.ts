import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import type { ClassifiedFieldSpec } from '../../src/via/classified/descriptor.js'

// Raw spec (presets land in Task 12). minLength validation is stage-1 write-seam work.
const passwordSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}

async function openUsers(store = inlineMemory()) {
  const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: { password: passwordSpec },
  })
  return { store, c }
}

describe('put() carry-forward (C6 end-to-end)', () => {
  it('writes _vdig, strips plaintext, and an unrelated update carries the slot byte-verbatim', async () => {
    const { store, c } = await openUsers()
    await c.put('u1', { name: 'Nok', password: 'correct-horse-battery' })
    const e1 = store._dump('v1', 'users', 'u1')!
    expect(e1._vdig?.password).toMatch(/^[^:]+:.+$/)
    expect(e1._sealed?.password).toBeUndefined()
    expect(JSON.stringify(await c.get('u1'))).not.toContain('correct-horse')

    await c.put('u1', { name: 'Nok Jaidee' })          // password absent from the write
    const e2 = store._dump('v1', 'users', 'u1')!
    expect(e2._vdig?.password).toBe(e1._vdig?.password) // byte-verbatim carry-forward
    expect((await c.get('u1')) as Record<string, unknown>).toMatchObject({ name: 'Nok Jaidee' })
  }, 60_000)

  it('explicit null clears the slot', async () => {
    const { store, c } = await openUsers()
    await c.put('u1', { name: 'Nok', password: 'correct-horse-battery' })
    await c.put('u1', { name: 'Nok', password: null })
    expect(store._dump('v1', 'users', 'u1')!._vdig?.password).toBeUndefined()
  }, 60_000)

  it('history snapshots carry the displaced _vdig (M3)', async () => {
    // History strategy defaults on; the snapshot is written to the _history-side
    // namespace by historyStrategy.saveHistory — assert via a second update after
    // which the LIVE envelope still has _vdig (regression canary for prev-threading
    // through the history encryptRecord call site: without it the codec fail-loud
    // throw from Task 7 fires and this put() rejects).
    const { store, c } = await openUsers()
    await c.put('u1', { name: 'a', password: 'correct-horse-battery' })
    await c.put('u1', { name: 'b' })
    await c.put('u1', { name: 'c' })
    expect(store._dump('v1', 'users', 'u1')!._vdig?.password).toBeDefined()
  }, 60_000)
})
