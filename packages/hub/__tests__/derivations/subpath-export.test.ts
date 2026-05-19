import { describe, it, expect } from 'vitest'

describe('@noy-db/hub/derivations subpath', () => {
  it('exposes withDerivation + error classes via subpath import', async () => {
    const mod = await import('@noy-db/hub/derivations')
    expect(typeof mod.withDerivation).toBe('function')
    expect(typeof mod.DerivationCycleError).toBe('function')
    expect(typeof mod.DerivationDepthError).toBe('function')
    expect(typeof mod.DerivationOutputUnknownError).toBe('function')
    expect(typeof mod.DerivationOutputShapeError).toBe('function')
  })

  it('instanceof works across main + subpath imports (ESM splitting)', async () => {
    const main = await import('@noy-db/hub')
    const sub = await import('@noy-db/hub/derivations')
    const e = new sub.DerivationCycleError(['a', 'b', 'a'])
    expect(e).toBeInstanceOf(main.DerivationCycleError)
  })
})
