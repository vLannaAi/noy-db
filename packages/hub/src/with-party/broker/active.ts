/**
 * Enable the credential-broker capability (#479, spec §5).
 *
 * Pass to `createNoydb({ brokerStrategy: withBroker(config) })` to make
 * `vault.broker()` live. Each method dynamic-imports the seed lifecycle
 * engine (`./seed.js`) — mirroring `via/classified/active.ts`'s per-method
 * dynamic-import seam — so `with-party/broker/seed.ts` (the heavy module:
 * the CAS enrol, quiesce-then-swap rotate, and the challenge/response round
 * trip) is reachable only through the `@noy-db/hub/broker` subpath and
 * never enters the single-user floor bundle.
 *
 * The single-flight, per-profile refresh cache (H-6/I6) lives HERE, in this
 * factory's closure — shared across every `credentialSource(profile)` call
 * for this one broker instance, so `rotate()` can quiesce it (await any
 * in-flight round-trip, then drop it) before the seed swap.
 */
import type { BrokerStrategy, BrokerConfig, BrokerCtx } from '../../port/with/broker-strategy.js'
import type { StoreCredentials, StoreCredentialSource } from '../../kernel/types.js'

const DEFAULT_SKEW_MS = 60_000
/** Floor under the skew-adjusted boundary so a sub-skew credential TTL
 *  doesn't collapse to "already expired" and thrash re-proving every call (I6b). */
const MIN_CACHE_MS = 1_000

interface CacheEntry {
  cached?: { creds: StoreCredentials; validUntil: number } | undefined
  inFlight?: Promise<StoreCredentials> | undefined
}

function cacheFloor(creds: StoreCredentials, skewMs: number): number {
  const expiresAtMs = creds.expiresAt ? Date.parse(creds.expiresAt) : Date.now() + skewMs * 2
  return Math.max(expiresAtMs - skewMs, Date.now() + MIN_CACHE_MS)
}

export function withBroker(config: BrokerConfig): BrokerStrategy {
  const cache = new Map<string, CacheEntry>()

  return {
    async enroll(ctx) {
      const { enrollSeed } = await import('./seed.js')
      return enrollSeed({ ...ctx, config })
    },
    async rotate(ctx) {
      // Quiesce (I5): let any in-flight round-trip finish (it may still be
      // proving under the pre-rotation seed) before the local record is
      // overwritten, then drop the cache so every future call starts fresh
      // under the new seed.
      const inFlight = [...cache.values()].map((e) => e.inFlight).filter((p): p is Promise<StoreCredentials> => p !== undefined)
      await Promise.allSettled(inFlight)
      cache.clear()
      const { rotateSeed } = await import('./seed.js')
      return rotateSeed({ ...ctx, config })
    },
    credentialSource(ctx: BrokerCtx, profile?: string): StoreCredentialSource {
      const key = profile ?? ''
      return async () => {
        let entry = cache.get(key)
        if (!entry) {
          entry = {}
          cache.set(key, entry)
        }
        const now = Date.now()
        if (entry.cached && now < entry.cached.validUntil) return entry.cached.creds
        if (entry.inFlight) return entry.inFlight

        const skewMs = config.skewMs ?? DEFAULT_SKEW_MS
        const capturedEntry = entry
        const inFlight = (async () => {
          const { mintStoreCredentials } = await import('./seed.js')
          const creds = await mintStoreCredentials({ ...ctx, config }, profile)
          capturedEntry.cached = { creds, validUntil: cacheFloor(creds, skewMs) }
          return creds
        })()
        entry.inFlight = inFlight
        try {
          return await inFlight
        } finally {
          // Clear-on-settle (I6a): a rejected in-flight promise must never
          // stay pinned in the cache, or every subsequent call would wedge
          // on the same rejection instead of retrying.
          capturedEntry.inFlight = undefined
        }
      }
    },
  }
}
