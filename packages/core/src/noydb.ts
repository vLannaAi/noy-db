import type { NoydbOptions, NoydbEventMap } from './types.js'
import { ValidationError } from './errors.js'
import { Compartment } from './compartment.js'
import { NoydbEventEmitter } from './events.js'
import { loadKeyring, createOwnerKeyring } from './keyring.js'
import type { UnlockedKeyring } from './keyring.js'

/** Dummy keyring for unencrypted mode — provides owner-level access without crypto. */
function createPlaintextKeyring(userId: string): UnlockedKeyring {
  return {
    userId,
    displayName: userId,
    role: 'owner',
    permissions: {},
    deks: new Map(),
    kek: null as unknown as CryptoKey, // never used in unencrypted mode
    salt: new Uint8Array(0),
  }
}

/** The top-level NOYDB instance. */
export class Noydb {
  private readonly options: NoydbOptions
  private readonly emitter = new NoydbEventEmitter()
  private keyring: UnlockedKeyring | null = null
  private readonly compartmentCache = new Map<string, Compartment>()

  constructor(options: NoydbOptions, keyring: UnlockedKeyring | null) {
    this.options = options
    this.keyring = keyring
  }

  /** Open a compartment by name. */
  compartment(name: string): Compartment {
    let comp = this.compartmentCache.get(name)
    if (!comp) {
      if (!this.keyring) {
        throw new ValidationError('Not authenticated — provide a secret or use biometric auth')
      }
      comp = new Compartment({
        adapter: this.options.adapter,
        name,
        keyring: this.keyring,
        encrypted: this.options.encrypt !== false,
        emitter: this.emitter,
      })
      this.compartmentCache.set(name, comp)
    }
    return comp
  }

  /** Subscribe to events. */
  on<K extends keyof NoydbEventMap>(
    event: K,
    handler: (data: NoydbEventMap[K]) => void,
  ): void {
    this.emitter.on(event, handler)
  }

  /** Unsubscribe from events. */
  off<K extends keyof NoydbEventMap>(
    event: K,
    handler: (data: NoydbEventMap[K]) => void,
  ): void {
    this.emitter.off(event, handler)
  }

  /** Close the instance and clear all keys from memory. */
  close(): void {
    this.keyring = null
    this.compartmentCache.clear()
    this.emitter.removeAllListeners()
  }
}

/**
 * Create a new NOYDB instance.
 *
 * @example
 * ```ts
 * const db = await createNoydb({
 *   adapter: jsonFile({ dir: './data' }),
 *   user: 'owner-01',
 *   secret: 'my-passphrase',
 * })
 * ```
 */
export async function createNoydb(options: NoydbOptions): Promise<Noydb> {
  const encrypted = options.encrypt !== false

  if (encrypted && !options.secret) {
    throw new ValidationError('A secret (passphrase) is required when encryption is enabled')
  }

  let keyring: UnlockedKeyring | null = null

  if (!encrypted) {
    // Unencrypted mode — no crypto needed
    keyring = createPlaintextKeyring(options.user)
  } else if (options.secret) {
    // Try to load existing keyring from the adapter
    try {
      keyring = await loadKeyring(
        options.adapter,
        '_default',
        options.user,
        options.secret,
      )
    } catch {
      // No keyring found — create owner keyring
      keyring = await createOwnerKeyring(
        options.adapter,
        '_default',
        options.user,
        options.secret,
      )
    }
  }

  return new Noydb(options, keyring)
}
