import { describe, it, expect } from 'vitest'
import {
  mintShareLink, verifyShareToken,
  SHARE_LINK_DEFAULT_TTL_MS, SHARE_LINK_MAX_TTL_MS,
} from './share-link.js'

const secret = new Uint8Array(32).fill(7)
const other = new Uint8Array(32).fill(9)
const BASE = 'https://fn.example.aws/'
const NOW = 1_700_000_000_000

function parse(url: string): { d: string; exp: string; sig: string } {
  const q = new URL(url).searchParams
  return { d: q.get('d')!, exp: q.get('exp')!, sig: q.get('sig')! }
}

describe('share-link mint + verify', () => {
  it('round-trips: a minted link verifies and returns the docId', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const v = await verifyShareToken(parse(url), secret, NOW + 1000)
    expect(v).toEqual({ ok: true, docId: 'doc-1' })
  })

  it('default exp is now + 24h', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    expect(Number(parse(url).exp)).toBe(NOW + SHARE_LINK_DEFAULT_TTL_MS)
  })

  it('rejects an expired token', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, ttlMs: 1000, nowMs: NOW })
    const v = await verifyShareToken(parse(url), secret, NOW + 2000)
    expect(v).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a tampered docId (sig no longer matches)', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const p = parse(url)
    const v = await verifyShareToken({ ...p, d: 'doc-2' }, secret, NOW + 1000)
    expect(v).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  it('rejects a tampered exp (old sig, bumped exp)', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, ttlMs: 1000, nowMs: NOW })
    const p = parse(url)
    const v = await verifyShareToken({ ...p, exp: String(NOW + 9_000_000) }, secret, NOW + 1000)
    expect(v).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  it('rejects a wrong-secret signature', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const v = await verifyShareToken(parse(url), other, NOW + 1000)
    expect(v).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  it('reports missing-token when any field is absent', async () => {
    expect(await verifyShareToken({ d: 'x', exp: '123' }, secret, NOW)).toEqual({ ok: false, reason: 'missing-token' })
    expect(await verifyShareToken({}, secret, NOW)).toEqual({ ok: false, reason: 'missing-token' })
  })

  it('reports malformed when exp is not a finite integer', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, nowMs: NOW })
    const p = parse(url)
    expect(await verifyShareToken({ ...p, exp: 'abc' }, secret, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('clamps ttlMs over the cap to SHARE_LINK_MAX_TTL_MS', async () => {
    const url = await mintShareLink('doc-1', { secret, baseUrl: BASE, ttlMs: SHARE_LINK_MAX_TTL_MS * 10, nowMs: NOW })
    expect(Number(parse(url).exp)).toBe(NOW + SHARE_LINK_MAX_TTL_MS)
  })
})
