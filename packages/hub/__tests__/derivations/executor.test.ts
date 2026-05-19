import { describe, it, expect } from 'vitest'
import { DerivationExecutor } from '../../src/derivations/executor.js'
import { withDerivation } from '../../src/derivations/with-derivation.js'
import { DerivationOutputShapeError } from '../../src/errors.js'

interface Source { id: string; body: string }
interface Meta { len: number }
interface Text { content: string }

describe('DerivationExecutor.run', () => {
  it('runs derive, returns per-output success/failure', async () => {
    const strategy = withDerivation<Source, { meta: Meta; text: Text }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        meta: { shape: 'record', collection: 'pdf-meta' },
        text: { shape: 'record', collection: 'pdf-text' },
      },
      derive: (s) => ({ meta: { len: s.body.length }, text: { content: s.body.toUpperCase() } }),
      lifecycle: 'eager',
    }).spec
    const result = await DerivationExecutor.run(strategy, { id: 'p1', body: 'hi' }, 1, 'hash')
    expect(result.outputs.meta.ok).toBe(true)
    expect(result.outputs.text.ok).toBe(true)
    // value contains both the derived data AND the _derivedFrom stamp
    const metaVal = result.outputs.meta.value as Meta & { _derivedFrom: any }
    expect(metaVal.len).toBe(2)
    expect(metaVal._derivedFrom).toBeDefined()
  })

  it('captures per-output exceptions in non-strict mode', async () => {
    const strategy = withDerivation<Source, { good: Meta; bad: Meta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        good: { shape: 'record', collection: 'g' },
        bad: { shape: 'record', collection: 'b' },
      },
      derive: () => { throw new Error('boom') },
      lifecycle: 'eager',
    }).spec
    const result = await DerivationExecutor.run(strategy, { id: 'p1', body: '' }, 1, 'hash')
    expect(result.failed).toBe(true)
    expect(result.outputs.good.ok).toBe(false)
  })

  it('throws DerivationOutputShapeError when derive returns missing keys', async () => {
    const strategy = withDerivation<Source, { meta: Meta; text: Text }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        meta: { shape: 'record', collection: 'pdf-meta' },
        text: { shape: 'record', collection: 'pdf-text' },
      },
      // missing 'text' in the returned object
      derive: ((s: Source) => ({ meta: { len: s.body.length } })) as any,
      lifecycle: 'eager',
    }).spec
    await expect(
      DerivationExecutor.run(strategy, { id: 'p1', body: 'x' }, 1, 'h'),
    ).rejects.toBeInstanceOf(DerivationOutputShapeError)
  })

  it('stamps _derivedFrom onto every output', async () => {
    const strategy = withDerivation<Source, { meta: Meta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    }).spec
    const result = await DerivationExecutor.run(strategy, { id: 'p1', body: 'hi' }, 3, 'STRAT')
    const out = result.outputs.meta.value as Meta & { _derivedFrom: any }
    expect(out._derivedFrom.source).toBe('pdfs')
    expect(out._derivedFrom.sourceId).toBe('p1')
    expect(out._derivedFrom.sourceVersion).toBe(3)
    expect(out._derivedFrom.strategyHash).toBe('STRAT')
  })
})
