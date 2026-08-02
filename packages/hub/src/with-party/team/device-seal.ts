import { NoydbError } from '../../kernel/errors.js'
import type { DeviceSealProvider } from '../../port/with/device-seal-strategy.js'

/**
 * Device-local sealer for the echo reveal-blob (spec decision 5).
 * DISTINCT from `SealingKeyProvider` (managed-secret mode, which seals
 * the WHOLE secret): this seals only the echo part, and only so an
 * enrolled device can display it during the unlock ceremony. The
 * sealed bytes may sit in the (untrusted) keyring file — attacker-B
 * resistance comes from `unseal` requiring this device's key store.
 *
 * The interface itself is declared on the `/with` port
 * ({@link DeviceSealProvider} from `port/with/device-seal-strategy.js`)
 * so the kernel spine can reference it without a static spine→service
 * import; re-exported here as the canonical consumer-facing home.
 */
export type { DeviceSealProvider }

/** In-memory test provider — AES-GCM under a per-instance random key. */
export class MemoryDeviceSealProvider implements DeviceSealProvider {
  readonly id: string
  private readonly keyPromise: Promise<CryptoKey>
  constructor(opts: { id: string }) {
    this.id = opts.id
    this.keyPromise = globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
  }
  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.keyPromise, plain as BufferSource),
    )
    const out = new Uint8Array(12 + ct.length)
    out.set(iv, 0)
    out.set(ct, 12)
    return out
  }
  async unseal(sealed: Uint8Array): Promise<Uint8Array> {
    try {
      return new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: sealed.slice(0, 12) },
          await this.keyPromise,
          sealed.slice(12) as BufferSource,
        ),
      )
    } catch {
      throw new NoydbError('DEVICE_SEAL_UNSEAL_FAILED', 'Device seal: unseal failed (tamper or wrong device).')
    }
  }
}
