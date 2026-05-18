import { describe, it, expect } from 'vitest'

describe('@noy-db/hub/guards subpath', () => {
  it('exposes withGuard + error classes via subpath import', async () => {
    const mod = await import('@noy-db/hub/guards')
    expect(typeof mod.withGuard).toBe('function')
    expect(typeof mod.RecordLockedError).toBe('function')
    expect(typeof mod.FieldFrozenError).toBe('function')
    expect(typeof mod.InvariantError).toBe('function')
    expect(typeof mod.AmendmentForbiddenError).toBe('function')
  })

  it('instanceof works across main + subpath imports (ESM splitting)', async () => {
    const main = await import('@noy-db/hub')
    const sub = await import('@noy-db/hub/guards')
    const e = new sub.RecordLockedError('w', 'w1', 'r')
    // Splitting: true in tsup.config.ts ensures one class definition shared via chunk
    expect(e).toBeInstanceOf(main.RecordLockedError)
  })
})
