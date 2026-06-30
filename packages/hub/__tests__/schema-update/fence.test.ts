import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { loadFence, saveFence, DEFAULT_FENCE } from '../../src/with-shape/schema-update/fence.js'

describe('fence storage', () => {
  it('returns DEFAULT_FENCE when none persisted', async () => {
    const store = memory()
    expect(await loadFence(store, 'v')).toEqual(DEFAULT_FENCE)
  })
  it('round-trips a saved fence', async () => {
    const store = memory()
    await saveFence(store, 'v', { currentSchemaVersion: 3, fenceState: 'migrating' })
    expect(await loadFence(store, 'v')).toEqual({ currentSchemaVersion: 3, fenceState: 'migrating' })
  })
  it('tolerates a corrupt envelope → DEFAULT_FENCE', async () => {
    const store = memory()
    await store.put('v', '_meta', 'schema-fence', {
      _noydb: 1, _v: 1, _ts: new Date(0).toISOString(), _iv: '', _data: 'not json',
    })
    expect(await loadFence(store, 'v')).toEqual(DEFAULT_FENCE)
  })
})
