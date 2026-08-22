import { describe, it, expect } from 'vitest'
import type { NoydbSealer } from '@noy-db/hub/at'

/**
 * Parameterized conformance suite for the `at-*` family port.
 *
 * Every `NoydbSealer` implementation must pass these. The contract is three
 * members — `id`, `seal`, `unseal` — and almost all of the risk is in what
 * `unseal` does when it is handed something it should refuse.
 *
 * These assertions are not new: hub has tested them as
 * `describe('NoydbSealer — contract')` against `MemorySealer` since managed
 * mode landed. What was missing is that a REAL provider — `at-env`,
 * `at-aws-kms`, or a third party's — had no way to run the same suite, so
 * every implementation was checked against its own idea of the contract. This
 * package is that extraction, mirroring `@noy-db/test-adapter-conformance`
 * for stores.
 *
 * ⚠️ `at-*` is the one NON-zero-knowledge family: a host you control can
 * decrypt the slice it unseals. That is deliberate, and it is why the
 * `unseal`-must-refuse cases below matter more here than anywhere else — a
 * provider that silently returns garbage instead of throwing hands hub a
 * "secret" that was never sealed by anyone.
 *
 * NOTE ON IMPORTS: this suite binds `@noy-db/hub/at`, the family seam. It was
 * written against the root barrel because `/at` did not exist yet — the seam
 * follows the port, not the other way round. `/at` and its four siblings
 * shipped in 0.3.0 with nothing behind them and were removed in 0.4.0 for
 * "zero importers"; it returns now because this package is what stands behind
 * it, and the five `at-*` providers bind it.
 */
export function runSealerConformanceTests(
  name: string,
  factory: () => Promise<NoydbSealer> | NoydbSealer,
  opts: {
    /**
     * A SECOND, differently-identified provider. Required: the single most
     * load-bearing property of a sealer is that its output is not portable to
     * another one, and that cannot be checked with one instance.
     */
    readonly other: () => Promise<NoydbSealer> | NoydbSealer
    /**
     * Skip the tamper case for providers whose backend authenticates
     * out-of-band and cannot be handed a corrupted blob (e.g. a keychain that
     * only ever returns what it stored). Defaults to running it.
     */
    readonly skipTamper?: boolean
  },
): void {
  const make = async () => await factory()
  const makeOther = async () => await opts.other()

  describe(`NoydbSealer conformance: ${name}`, () => {
    it('seal → unseal round-trips the exact bytes', async () => {
      const sealer = await make()
      const secret = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252])
      const out = await sealer.unseal(await sealer.seal(secret))
      expect(Array.from(out)).toEqual(Array.from(secret))
    })

    it('round-trips an empty secret', async () => {
      // Zero-length is the boundary a length-prefixed or padded format is
      // most likely to get wrong, and hub never guarantees a minimum size.
      const sealer = await make()
      const out = await sealer.unseal(await sealer.seal(new Uint8Array(0)))
      expect(out.length).toBe(0)
    })

    it('round-trips a secret larger than one block', async () => {
      const sealer = await make()
      const secret = new Uint8Array(4096).map((_, i) => i % 256)
      const out = await sealer.unseal(await sealer.seal(secret))
      expect(Array.from(out)).toEqual(Array.from(secret))
    })

    it('produces output that is NOT the plaintext', async () => {
      // Catches a no-op or pass-through implementation, which round-trips
      // perfectly and seals nothing.
      const sealer = await make()
      const secret = new TextEncoder().encode('a recognisable secret')
      const sealed = await sealer.seal(secret)
      expect(Buffer.from(sealed).includes(Buffer.from(secret))).toBe(false)
    })

    it('THROWS when another provider tries to unseal its output', async () => {
      // The property hub relies on: `providerId` is audit metadata, not a
      // guard, so the only thing stopping a wrong-provider open is unseal
      // refusing. A provider that succeeds here silently unlocks vaults it
      // has no claim to.
      const a = await make()
      const b = await makeOther()
      expect(a.id).not.toEqual(b.id)
      await expect(b.unseal(await a.seal(new Uint8Array([9, 9, 9])))).rejects.toThrow()
    })

    it('THROWS on unsealing bytes that were never sealed', async () => {
      const sealer = await make()
      await expect(sealer.unseal(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).rejects.toThrow()
    })

    it('THROWS on unsealing an empty buffer', async () => {
      const sealer = await make()
      await expect(sealer.unseal(new Uint8Array(0))).rejects.toThrow()
    })

    it.skipIf(opts.skipTamper)('THROWS on a tampered sealed blob', async () => {
      const sealer = await make()
      const sealed = await sealer.seal(new TextEncoder().encode('tamper me'))
      const corrupted = Uint8Array.from(sealed)
      const last = corrupted.length - 1
      corrupted[last] = (corrupted[last] ?? 0) ^ 0xff
      await expect(sealer.unseal(corrupted)).rejects.toThrow()
    })

    it('exposes a non-empty `id`', async () => {
      const sealer = await make()
      expect(typeof sealer.id).toBe('string')
      expect(sealer.id.length).toBeGreaterThan(0)
    })

    it('keeps `id` stable across calls — hub persists it in the envelope', async () => {
      const sealer = await make()
      const first = sealer.id
      await sealer.seal(new Uint8Array([1]))
      expect(sealer.id).toBe(first)
    })

    it('does not leak the secret through `id`', async () => {
      // `id` is documented NOT secret and "fine to log". A provider that
      // derives it from the material it protects makes that documentation
      // false for every consumer that believed it.
      const sealer = await make()
      const secret = new TextEncoder().encode('super-secret-value')
      await sealer.seal(secret)
      expect(sealer.id).not.toContain('super-secret-value')
    })
  })
}

/**
 * Obligations for a DELEGATING provider — one whose `seal` IS the service call.
 *
 * `runSealerConformanceTests` cannot be run against `at-aws-kms`,
 * `at-gcp-kms` or `at-azure-keyvault` without real credentials, because the
 * properties it asserts (refusing tampered, foreign or garbage input) are the
 * SERVICE's behaviour. Standing a fake KMS in front of them would test the
 * fake.
 *
 * Two obligations remain squarely the provider's, and a stub client covers
 * them honestly:
 *
 *   1. a service failure must SURFACE — never be swallowed into a resolved
 *      promise. hub reads a thrown error as "this provider cannot unlock this
 *      vault"; a provider that swallows one reports success for a vault it
 *      never opened.
 *   2. a response with no ciphertext/plaintext must THROW — never be
 *      fabricated into empty bytes. Returning `new Uint8Array(0)` for a failed
 *      Decrypt hands hub a "secret" nobody sealed.
 *
 * The caller supplies the providers, because each SDK's client shape differs
 * and this package should not know about any of them.
 *
 * NOTE: at time of writing all wired providers already satisfy both. These
 * tests PIN the behaviour rather than having found it missing — which is worth
 * saying, so nobody reads a green run as evidence a bug was caught.
 */
export function runDelegatingSealerObligations(
  name: string,
  providers: {
    /** Built with a client whose calls REJECT. */
    readonly rejecting: () => Promise<NoydbSealer> | NoydbSealer
    /** Built with a client that RESOLVES but returns no ciphertext/plaintext. */
    readonly empty: () => Promise<NoydbSealer> | NoydbSealer
  },
): void {
  describe(`Delegating-sealer obligations: ${name}`, () => {
    it('seal THROWS when the service call rejects — never swallows it', async () => {
      const s = await providers.rejecting()
      await expect(s.seal(new Uint8Array([1, 2, 3]))).rejects.toThrow()
    })

    it('unseal THROWS when the service call rejects — never swallows it', async () => {
      const s = await providers.rejecting()
      await expect(s.unseal(new Uint8Array([1, 2, 3]))).rejects.toThrow()
    })

    it('seal THROWS when the service returns no ciphertext — never fabricates', async () => {
      const s = await providers.empty()
      await expect(s.seal(new Uint8Array([1, 2, 3]))).rejects.toThrow()
    })

    it('unseal THROWS when the service returns no plaintext — never fabricates', async () => {
      const s = await providers.empty()
      await expect(s.unseal(new Uint8Array([1, 2, 3]))).rejects.toThrow()
    })
  })
}
