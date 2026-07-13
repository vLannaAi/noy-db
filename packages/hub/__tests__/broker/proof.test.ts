/**
 * Enclave broker proof crypto — primitive-level conformance vectors (#479,
 * credential-broker spec §3/§8 slice 2). Vector ids in each test name map
 * 1:1 to the spec's `§8 Conformance vectors` list.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BROKER_PROOF_DOMAIN,
  BROKER_PROOF_VERSION,
  computeBrokerProof,
  deriveBrokerProofBits,
  deriveBrokerProofKey,
  issueChallenge,
  verifyBrokerProof,
} from '../../src/kernel/enclave/broker/proof.js'
import type { VerifyBrokerProofArgs } from '../../src/kernel/enclave/broker/proof.js'

const subtle = globalThis.crypto.subtle

function randomSeed(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
}

/** Simulates the broker host's single-use challenge store. */
function makeStore() {
  const active = new Set<string>()
  return {
    active,
    consumeChallenge: async (challenge: string): Promise<boolean> => {
      if (!active.has(challenge)) return false
      active.delete(challenge)
      return true
    },
  }
}

/** The registered value: the raw HKDF bits, never zeroed (mirrors one-time enrol registration). */
async function registerFor(seed: Uint8Array, vaultId: string, brokerId: string): Promise<Uint8Array> {
  return deriveBrokerProofBits(seed, vaultId, brokerId)
}

describe('kernel/enclave/broker/proof', () => {
  it('pins the domain constants (HKDF salt/info tag and MAC version tag)', () => {
    expect(BROKER_PROOF_DOMAIN).toBe('noydb-broker-proof')
    expect(BROKER_PROOF_VERSION).toBe('noydb-broker-proof-v1')
  })

  it('happy path: derive → registered bits → challenge → compute → verify true', async () => {
    const vaultId = 'vault-1'
    const brokerId = 'broker-1'
    const endpointOrigin = 'https://broker.example.com'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

    const { challenge, expiresAt } = issueChallenge()
    const store = makeStore()
    store.active.add(challenge)

    const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, {
      endpointOrigin, profile: 'read', challenge, expiresAt,
    })

    const ok = await verifyBrokerProof({
      consumeChallenge: store.consumeChallenge,
      registeredProofKey,
      vaultId, endpointOrigin, brokerId, profile: 'read',
      challenge, expiresAt, proof,
    })
    expect(ok).toBe(true)
  })

  it('V1: binds vaultId — verifying under a different vaultId fails even with the correct registered key', async () => {
    const brokerId = 'broker-1'
    const endpointOrigin = 'https://broker.example.com'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), 'vault-A', brokerId)

    const { challenge, expiresAt } = issueChallenge()
    const store = makeStore()
    store.active.add(challenge)

    const proof = await computeBrokerProof(seed.slice(), 'vault-A', brokerId, { endpointOrigin, challenge, expiresAt })

    const ok = await verifyBrokerProof({
      consumeChallenge: store.consumeChallenge,
      registeredProofKey,
      vaultId: 'vault-B', // replayed under a different vault
      endpointOrigin, brokerId, challenge, expiresAt, proof,
    })
    expect(ok).toBe(false)
  })

  it('V3: binds challenge — a proof computed under challenge A fails when submitted with a different, still-fresh challenge B', async () => {
    const vaultId = 'vault-1'
    const brokerId = 'broker-1'
    const endpointOrigin = 'https://broker.example.com'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

    const a = issueChallenge()
    const b = issueChallenge()
    const store = makeStore()
    store.active.add(a.challenge)
    store.active.add(b.challenge)

    const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, {
      endpointOrigin, challenge: a.challenge, expiresAt: a.expiresAt,
    })

    const ok = await verifyBrokerProof({
      consumeChallenge: store.consumeChallenge,
      registeredProofKey, vaultId, endpointOrigin, brokerId,
      challenge: b.challenge, expiresAt: a.expiresAt, proof,
    })
    expect(ok).toBe(false)
    // b was burned by the attempt (fresh, so consumeChallenge burned it) — the MAC compare is what rejected it.
    expect(store.active.has(b.challenge)).toBe(false)
  })

  it('V4: expired expiresAt fails even with a valid MAC (client clock untrusted)', async () => {
    const vaultId = 'vault-1'
    const brokerId = 'broker-1'
    const endpointOrigin = 'https://broker.example.com'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

    const { challenge } = issueChallenge()
    const store = makeStore()
    store.active.add(challenge)
    const expiresAt = new Date(Date.now() - 60_000).toISOString() // already in the past

    const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, { endpointOrigin, challenge, expiresAt })

    const ok = await verifyBrokerProof({
      consumeChallenge: store.consumeChallenge,
      registeredProofKey, vaultId, endpointOrigin, brokerId, challenge, expiresAt, proof,
    })
    expect(ok).toBe(false)
  })

  it('V5: burn-first — consumeChallenge runs before any HMAC work; replaying a burned challenge with a byte-identical valid proof fails with zero additional subtle.verify calls', async () => {
    const vaultId = 'vault-1'
    const brokerId = 'broker-1'
    const endpointOrigin = 'https://broker.example.com'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

    const { challenge, expiresAt } = issueChallenge()
    const store = makeStore()
    store.active.add(challenge)

    const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, { endpointOrigin, challenge, expiresAt })

    const consumeChallenge = vi.fn(store.consumeChallenge)
    const verifySpy = vi.spyOn(subtle, 'verify')

    const args: VerifyBrokerProofArgs = {
      consumeChallenge, registeredProofKey, vaultId, endpointOrigin, brokerId, challenge, expiresAt, proof,
    }

    const first = await verifyBrokerProof(args)
    expect(first).toBe(true)
    expect(verifySpy).toHaveBeenCalledTimes(1)

    // Replay: same byte-identical proof/challenge, now burned.
    const second = await verifyBrokerProof(args)
    expect(second).toBe(false)
    expect(consumeChallenge).toHaveBeenCalledTimes(2)
    expect(consumeChallenge).toHaveBeenNthCalledWith(2, challenge)
    // No new subtle.verify call on the burned path — consumeChallenge short-circuited BEFORE any MAC work.
    expect(verifySpy).toHaveBeenCalledTimes(1)

    verifySpy.mockRestore()
  })

  it('V18: profile-binding — a proof minted for profile "read" fails verification at "admin"', async () => {
    const vaultId = 'vault-1'
    const brokerId = 'broker-1'
    const endpointOrigin = 'https://broker.example.com'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

    const { challenge, expiresAt } = issueChallenge()
    const store = makeStore()
    store.active.add(challenge)

    const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, {
      endpointOrigin, profile: 'read', challenge, expiresAt,
    })

    const ok = await verifyBrokerProof({
      consumeChallenge: store.consumeChallenge,
      registeredProofKey, vaultId, endpointOrigin, brokerId, profile: 'admin', challenge, expiresAt, proof,
    })
    expect(ok).toBe(false)
  })

  it('V19: endpoint-binding — same brokerId, different endpointOrigin fails', async () => {
    const vaultId = 'vault-1'
    const brokerId = 'shared-broker'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

    const { challenge, expiresAt } = issueChallenge()
    const store = makeStore()
    store.active.add(challenge)

    const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, {
      endpointOrigin: 'https://a.example.com', challenge, expiresAt,
    })

    const ok = await verifyBrokerProof({
      consumeChallenge: store.consumeChallenge,
      registeredProofKey, vaultId, endpointOrigin: 'https://b.example.com', brokerId, challenge, expiresAt, proof,
    })
    expect(ok).toBe(false)
  })

  it('V12: the steady-state proof key is non-extractable — exportKey throws', async () => {
    const seed = randomSeed()
    const key = await deriveBrokerProofKey(seed, 'vault-1', 'broker-1')
    await expect(subtle.exportKey('raw', key)).rejects.toThrow()
  })

  describe('F7: empty-string instancePid is forbidden; absent is fine', () => {
    it('computeBrokerProof throws on instancePid === ""', async () => {
      const seed = randomSeed()
      await expect(
        computeBrokerProof(seed, 'vault-1', 'broker-1', {
          endpointOrigin: 'https://broker.example.com',
          instancePid: '',
          challenge: 'c',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ).rejects.toThrow()
    })

    it('computeBrokerProof succeeds when instancePid is omitted entirely', async () => {
      const seed = randomSeed()
      const { challenge, expiresAt } = issueChallenge()
      const proof = await computeBrokerProof(seed, 'vault-1', 'broker-1', {
        endpointOrigin: 'https://broker.example.com', challenge, expiresAt,
      })
      expect(typeof proof).toBe('string')
      expect(proof.length).toBeGreaterThan(0)
    })

    it('verifyBrokerProof rejects instancePid === "" (after burning the challenge)', async () => {
      const vaultId = 'vault-1'
      const brokerId = 'broker-1'
      const endpointOrigin = 'https://broker.example.com'
      const seed = randomSeed()
      const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

      const { challenge, expiresAt } = issueChallenge()
      const store = makeStore()
      store.active.add(challenge)

      const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, { endpointOrigin, challenge, expiresAt })

      const ok = await verifyBrokerProof({
        consumeChallenge: store.consumeChallenge,
        registeredProofKey, vaultId, endpointOrigin, brokerId, instancePid: '', challenge, expiresAt, proof,
      })
      expect(ok).toBe(false)
      // The challenge is still burned even though the request was ultimately rejected (F2 burn-first order).
      expect(store.active.has(challenge)).toBe(false)
    })

    it('verifyBrokerProof succeeds when instancePid is absent on both sides', async () => {
      const vaultId = 'vault-1'
      const brokerId = 'broker-1'
      const endpointOrigin = 'https://broker.example.com'
      const seed = randomSeed()
      const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

      const { challenge, expiresAt } = issueChallenge()
      const store = makeStore()
      store.active.add(challenge)

      const proof = await computeBrokerProof(seed.slice(), vaultId, brokerId, { endpointOrigin, challenge, expiresAt })

      const ok = await verifyBrokerProof({
        consumeChallenge: store.consumeChallenge,
        registeredProofKey, vaultId, endpointOrigin, brokerId, challenge, expiresAt, proof,
      })
      expect(ok).toBe(true)
    })
  })

  it('F8: a byte-reformatted expiresAt (Z vs +00:00 for the identical instant) fails; the verbatim string verifies', async () => {
    const vaultId = 'vault-1'
    const brokerId = 'broker-1'
    const endpointOrigin = 'https://broker.example.com'
    const seed = randomSeed()
    const registeredProofKey = await registerFor(seed.slice(), vaultId, brokerId)

    const expiresAtZ = new Date(Date.now() + 60_000).toISOString()
    const reformatted = expiresAtZ.replace('Z', '+00:00')
    expect(reformatted).not.toBe(expiresAtZ)
    expect(Date.parse(reformatted)).toBe(Date.parse(expiresAtZ)) // same instant, different bytes

    // Attempt 1: proof computed under the verbatim `Z` string, submitted with the reformatted string.
    const c1 = issueChallenge()
    const store1 = makeStore()
    store1.active.add(c1.challenge)
    const proof1 = await computeBrokerProof(seed.slice(), vaultId, brokerId, {
      endpointOrigin, challenge: c1.challenge, expiresAt: expiresAtZ,
    })
    const ok1 = await verifyBrokerProof({
      consumeChallenge: store1.consumeChallenge,
      registeredProofKey, vaultId, endpointOrigin, brokerId,
      challenge: c1.challenge, expiresAt: reformatted, proof: proof1,
    })
    expect(ok1).toBe(false)

    // Attempt 2: the identical verbatim string on both sides verifies.
    const c2 = issueChallenge()
    const store2 = makeStore()
    store2.active.add(c2.challenge)
    const proof2 = await computeBrokerProof(seed.slice(), vaultId, brokerId, {
      endpointOrigin, challenge: c2.challenge, expiresAt: expiresAtZ,
    })
    const ok2 = await verifyBrokerProof({
      consumeChallenge: store2.consumeChallenge,
      registeredProofKey, vaultId, endpointOrigin, brokerId,
      challenge: c2.challenge, expiresAt: expiresAtZ, proof: proof2,
    })
    expect(ok2).toBe(true)
  })

  describe('F5: zeroing — seed and transient HKDF bits are zeroed on every path, including a thrown one', () => {
    it('happy path: the seed argument and the transient HKDF bits read all-zero after computeBrokerProof returns', async () => {
      const vaultId = 'vault-1'
      const brokerId = 'broker-1'
      const endpointOrigin = 'https://broker.example.com'
      const seed = randomSeed()
      expect([...seed].some((b) => b !== 0)).toBe(true) // sanity: not already all-zero

      const importKeySpy = vi.spyOn(subtle, 'importKey')

      const { challenge, expiresAt } = issueChallenge()
      await computeBrokerProof(seed, vaultId, brokerId, { endpointOrigin, challenge, expiresAt })

      // seed, passed by reference, is zeroed by computeBrokerProof's own finally.
      expect([...seed]).toEqual(new Array(32).fill(0))

      // The transient proofBits buffer is the SAME object importKey received for the
      // ['sign'] HMAC import — deriveBrokerProofKey zeroes it in its own finally
      // before returning, so the captured reference now reads all-zero too.
      const signImportCall = importKeySpy.mock.calls.find(
        (call) => typeof call[2] === 'object' && call[2] !== null && (call[2] as { name?: string }).name === 'HMAC',
      )
      expect(signImportCall).toBeDefined()
      const capturedBits = signImportCall![1] as Uint8Array
      expect([...capturedBits]).toEqual(new Array(32).fill(0))

      importKeySpy.mockRestore()
    })

    it('injected-throw path: the seed argument is still zeroed when the HMAC key import fails mid-derivation', async () => {
      const vaultId = 'vault-1'
      const brokerId = 'broker-1'
      const endpointOrigin = 'https://broker.example.com'
      const seed = randomSeed()
      expect([...seed].some((b) => b !== 0)).toBe(true)

      const realImportKey = subtle.importKey.bind(subtle)
      const importKeySpy = vi.spyOn(subtle, 'importKey').mockImplementation(async (format, keyData, algo, extractable, usages) => {
        if (typeof algo === 'object' && algo !== null && (algo as { name?: string }).name === 'HMAC') {
          throw new Error('injected importKey failure (simulated crypto fault)')
        }
        return realImportKey(format, keyData as never, algo as never, extractable as boolean, usages as never)
      })

      const { challenge, expiresAt } = issueChallenge()
      await expect(
        computeBrokerProof(seed, vaultId, brokerId, { endpointOrigin, challenge, expiresAt }),
      ).rejects.toThrow('injected importKey failure')

      expect([...seed]).toEqual(new Array(32).fill(0)) // zeroed even though the call threw

      importKeySpy.mockRestore()
    })
  })
})
