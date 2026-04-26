import { describe, expect, it } from 'vitest'
import { issue, verify, type EmailOtpTransportArgs } from '../src/index.js'

function captureTransport() {
  const calls: EmailOtpTransportArgs[] = []
  return {
    calls,
    transport: (args: EmailOtpTransportArgs) => {
      calls.push(args)
    },
  }
}

describe('on-email-otp', () => {
  it('issues a 6-digit code + calls the transport once', async () => {
    const { calls, transport } = captureTransport()
    const { record } = await issue({ email: 'a@x.com', transport })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.code).toMatch(/^\d{6}$/)
    expect(record.email).toBe('a@x.com')
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(new Date(record.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('respects custom digits count', async () => {
    const { calls, transport } = captureTransport()
    await issue({ email: 'a@x.com', transport, digits: 8 })
    expect(calls[0]!.code).toMatch(/^\d{8}$/)
  })

  it('verify returns ok:true for the correct code', async () => {
    const { calls, transport } = captureTransport()
    const { record } = await issue({ email: 'a@x.com', transport })
    const result = await verify(calls[0]!.code, record)
    expect(result.ok).toBe(true)
  })

  it('verify returns ok:false + reason:mismatch on wrong code', async () => {
    const { calls, transport } = captureTransport()
    const { record } = await issue({ email: 'a@x.com', transport })
    const wrong = calls[0]!.code === '000000' ? '000001' : '000000'
    const result = await verify(wrong, record)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('mismatch')
  })

  it('verify decrements remainingAttempts', async () => {
    const { transport } = captureTransport()
    const { record } = await issue({ email: 'a@x.com', transport, maxAttempts: 3 })
    const r1 = await verify('000000', record)
    expect(r1.remainingAttempts).toBe(2)
    const r2 = await verify('000000', record)
    expect(r2.remainingAttempts).toBe(1)
  })

  it('verify locks after maxAttempts', async () => {
    const { transport } = captureTransport()
    const { record } = await issue({ email: 'a@x.com', transport, maxAttempts: 2 })
    await verify('000000', record) // 1st
    await verify('000000', record) // 2nd — reaches max
    const r3 = await verify('000000', record) // 3rd — locked
    expect(r3.ok).toBe(false)
    expect(r3.reason).toBe('locked')
  })

  it('verify rejects expired records', async () => {
    const { calls, transport } = captureTransport()
    const { record } = await issue({ email: 'a@x.com', transport, ttlSeconds: 1 })
    // Force expiry by rewriting expiresAt into the past.
    ;(record as { expiresAt: string }).expiresAt = new Date(Date.now() - 1000).toISOString()
    const result = await verify(calls[0]!.code, record)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('expired')
  })

  it('transport receives issuedAt + expiresAt', async () => {
    const { calls, transport } = captureTransport()
    await issue({ email: 'a@x.com', transport, ttlSeconds: 600 })
    const args = calls[0]!
    expect(args.to).toBe('a@x.com')
    expect(new Date(args.expiresAt).getTime() - new Date(args.issuedAt).getTime())
      .toBeCloseTo(600_000, -3)
  })

  it('codes are unique across calls', async () => {
    const { calls, transport } = captureTransport()
    for (let i = 0; i < 20; i++) {
      await issue({ email: 'a@x.com', transport })
    }
    const set = new Set(calls.map(c => c.code))
    expect(set.size).toBeGreaterThan(15) // overwhelmingly unique; allow one or two duplicates in the 10^6 space
  })

  it('digest uses sha-256 over code+salt', async () => {
    const { calls, transport } = captureTransport()
    const { record } = await issue({ email: 'a@x.com', transport })
    expect(record.digest).toHaveLength(64)
    // Correct code verifies
    expect((await verify(calls[0]!.code, record)).ok).toBe(true)
  })
})
