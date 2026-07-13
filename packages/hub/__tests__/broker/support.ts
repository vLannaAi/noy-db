/**
 * Shared test doubles for the broker suites (#479 slice 2b) — an in-memory
 * `NoydbStore` (same shape as `__tests__/sync-credentials.test.ts`'s) and a
 * mock broker HOST implementing `/enroll`, `/challenge`, `/credentials`
 * over a `fetch`-compatible function, so `BrokerConfig.fetch` can DI it
 * straight into `withBroker()`.
 *
 * Not a `*.test.ts` file — vitest never collects it as a suite.
 */
import { ConflictError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { issueChallenge, verifyBrokerProof, base64ToBuffer } from '../../src/kernel/enclave/index.js'

// ─── In-memory NoydbStore (mirrors __tests__/sync-credentials.test.ts) ─────

export function memoryStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      if (ev !== undefined && !ex && ev !== 0) throw new ConflictError(0)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c): Promise<VaultSnapshot> {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = getCollection(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

// ─── Mock broker host ───────────────────────────────────────────────────

export interface TestHost {
  /** DI straight into `BrokerConfig.fetch`. */
  fetch: typeof fetch
  /** Number of distinct proof keys ever registered for (vaultId, brokerId) — grace-window visibility. */
  registeredKeyCount: (vaultId: string, brokerId: string) => number
  /** Spy-friendly counters. */
  calls: { enroll: number; challenge: number; credentials: number }
}

export interface TestHostOptions {
  /** Require a bearer attestation header on /enroll (V10). */
  requireAttestation?: boolean
  /** Fixed credentials payload /credentials returns on a verified proof. */
  credentials?: () => Record<string, unknown>
  /** Force /credentials to always 401 (simulates a down/misconfigured host, distinct from a network failure). */
  rejectProofs?: boolean
}

/**
 * A minimal in-process broker host: KMS-wrap is irrelevant here (this is a
 * plaintext test double, not the reference host), but the burn-before-compare
 * and grace-window (accept old+new registered keys) semantics are real,
 * exercised via the actual `issueChallenge`/`verifyBrokerProof` enclave
 * primitives — the same ones a real host would call.
 */
export function makeTestHost(opts: TestHostOptions = {}): TestHost {
  const registered = new Map<string, Set<string>>() // `${vaultId}:${brokerId}` -> base64 proof keys
  const challengeExpiry = new Map<string, string>() // challenge -> expiresAt (verbatim, as issued)
  const calls = { enroll: 0, challenge: 0, credentials: 0 }

  function keyFor(vaultId: string, brokerId: string): string {
    return `${vaultId}:${brokerId}`
  }

  async function burnChallenge(challenge: string): Promise<boolean> {
    return challengeExpiry.delete(challenge)
  }

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {}

    if (url.pathname === '/enroll') {
      calls.enroll++
      if (opts.requireAttestation) {
        const headers = new Headers(init?.headers)
        if (!headers.get('authorization')) return new Response(null, { status: 401 })
      }
      const key = keyFor(body.vaultId as string, body.brokerId as string)
      let set = registered.get(key)
      if (!set) { set = new Set(); registered.set(key, set) }
      set.add(body.proofKey as string)
      return new Response(null, { status: 200 })
    }

    if (url.pathname === '/challenge') {
      calls.challenge++
      const { challenge, expiresAt } = issueChallenge()
      challengeExpiry.set(challenge, expiresAt)
      return new Response(JSON.stringify({ challenge, expiresAt }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }

    if (url.pathname === '/credentials') {
      calls.credentials++
      if (opts.rejectProofs) return new Response(null, { status: 401 })

      const challenge = body.challenge as string
      const expiresAt = challengeExpiry.get(challenge)
      const fresh = await burnChallenge(challenge)
      const key = keyFor(body.vaultId as string, body.brokerId as string)
      const candidates = registered.get(key) ?? new Set<string>()

      let ok = false
      if (fresh && expiresAt !== undefined) {
        for (const candidateB64 of candidates) {
          const verified = await verifyBrokerProof({
            consumeChallenge: async () => true, // already burned above
            registeredProofKey: base64ToBuffer(candidateB64),
            vaultId: body.vaultId as string,
            endpointOrigin: url.origin,
            brokerId: body.brokerId as string,
            ...(body.profile !== undefined ? { profile: body.profile as string } : {}),
            challenge,
            expiresAt,
            proof: body.proof as string,
          })
          if (verified) { ok = true; break }
        }
      }
      if (!ok) return new Response(null, { status: 401 })
      const creds = opts.credentials?.() ?? {
        kind: 'aws',
        accessKeyId: 'AKIDTEST',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }
      return new Response(JSON.stringify(creds), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    return new Response(null, { status: 404 })
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    registeredKeyCount: (vaultId, brokerId) => registered.get(keyFor(vaultId, brokerId))?.size ?? 0,
    calls,
  }
}
