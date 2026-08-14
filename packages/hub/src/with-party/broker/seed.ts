/**
 * `_broker` reserved-collection seed lifecycle (#479, credential-broker
 * spec §2/§3). Modeled on `with-sync/credentials.ts`: a
 * `_`-prefixed reserved collection, record id = `brokerId`, encrypted under
 * the collection's own DEK, `requireAdminAccess` role gate (owner/admin
 * only — custodian intentionally excluded, same rationale as
 * `_sync_credentials`: this is transport-auth material, not the
 * custodian's operational scope).
 *
 * Three operations, each a free function taking a {@link BrokerSeedCtx}
 * (the {@link BrokerCtx} threaded through `with-party/broker/active.ts`,
 * augmented there with the `config` its closure was built with):
 *
 *  - {@link enrollSeed} — two-phase commit (I9): create-if-absent CAS the
 *    seed (I4), then register its derived proof key with the broker host,
 *    then (only on a 2xx) mark the record `registered: true`. A seed
 *    persisted whose `/enroll` POST failed stays `registered: false` so a
 *    later `credentialSource()` fails fast instead of degrading into an
 *    opaque `BrokerProofError` (I9/V23).
 *  - {@link rotateSeed} — quiesce-then-swap (I5): mint a fresh seed,
 *    register-new-first, THEN overwrite the local record — closing the
 *    torn-proof window a naive local-overwrite-then-register order would
 *    open. The single-flight cache quiesce itself (await in-flight, bump
 *    epoch) is the caller's job (`with-party/broker/active.ts`) since the
 *    cache lives in that closure, not here.
 *  - {@link mintStoreCredentials} — the challenge/response round trip
 *    (`/challenge` then `/credentials`) that produces one `StoreCredentials`
 *    value; the single-flight cache wrapping it lives in `active.ts`.
 *
 * First-seed creation calls `ensureCollectionDEK`, which throws
 * (`ValidationError`) when the keyring's KEK is `null` (PIN quick-resume /
 * session-restore) — this module intercepts that and re-surfaces it as
 * {@link BrokerEnrolmentError} (R-B8/I3): *enrol* needs the KEK; *use* of an
 * already-enrolled seed needs only the DEK.
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope, StoreCredentials } from '../../kernel/types.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import { ensureCollectionDEK } from '../../with-party/team/keyring.js'
import { BROKER_COLLECTION } from '../../with-party/team/reserved-secret-collections.js'
import {
  buildSealedRecordEnvelope,
  openEnvelopeJson,
  writeEnvelopeBody,
  bufferToBase64,
  base64ToBuffer,
  deriveBrokerProofBits,
  computeBrokerProof,
} from '../../kernel/enclave/index.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import {
  PermissionDeniedError,
  ValidationError,
  isConflictError,
  NetworkError,
  BrokerEnrolmentError,
  BrokerProofError,
} from '../../kernel/errors.js'
import type { BrokerSeedCtx, BrokerConfig } from '../../port/with/broker-strategy.js'

/** The `_broker/<brokerId>` record payload (spec §3). */
export interface BrokerSeedRecord {
  readonly brokerId: string
  /** base64(32 random bytes). */
  readonly seed: string
  readonly endpoint: string
  readonly createdAt: string
  /** `true` only once `/enroll` has returned a 2xx for this seed (I9). */
  readonly registered: boolean
}

function requireAdminAccess(keyring: UnlockedKeyring): void {
  // Custodian is INTENTIONALLY excluded — the _broker seed is transport-auth
  // material (mints cloud store credentials), not the custodian's
  // operational data scope. Same rationale as _sync_credentials' FR-6 note.
  if (keyring.role !== 'owner' && keyring.role !== 'admin') {
    throw new PermissionDeniedError(
      `Credential-broker operations require owner or admin role. Current role: "${keyring.role}"`,
    )
  }
}

// `ensureCollectionDEK` only dedupes concurrent first-time DEK creates WITHIN one
// closure instance — since every call site here asks for a fresh closure, two
// concurrent `enrollSeed()` calls sharing the same (store, vault, keyring) would
// otherwise each mint a DIFFERENT `_broker` DEK and race `persistKeyring`, leaving
// the seed record encrypted under a DEK the keyring no longer holds (TamperedError
// on the next read). Dedupe across calls here, keyed by store identity + vault
// (V20 — the CAS enrol vector actually exercises this).
const inFlightDekByStore = new WeakMap<NoydbStore, Map<string, Promise<EnclaveKey>>>()

async function brokerDek(store: NoydbStore, vault: string, keyring: UnlockedKeyring): Promise<EnclaveKey> {
  const existing = keyring.deks.get(BROKER_COLLECTION)
  if (existing) return existing

  let perStore = inFlightDekByStore.get(store)
  if (!perStore) { perStore = new Map(); inFlightDekByStore.set(store, perStore) }
  const pending = perStore.get(vault)
  if (pending) return pending

  const promise = (async () => {
    try {
      const getDek = await ensureCollectionDEK(store, vault, keyring)
      return await getDek(BROKER_COLLECTION)
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new BrokerEnrolmentError(
          'enroll()/rotate() need the KEK to provision the _broker DEK on first use — ' +
            're-authenticate at tier 1 (secret) before enrolling. Using an already-' +
            'enrolled seed (credentialSource()) needs only the DEK.',
        )
      }
      throw err
    }
  })()
  perStore.set(vault, promise)
  try {
    return await promise
  } finally {
    perStore.delete(vault)
  }
}

async function readRecord(
  store: NoydbStore,
  vault: string,
  brokerId: string,
  dek: EnclaveKey,
): Promise<{ envelope: EncryptedEnvelope; record: BrokerSeedRecord } | null> {
  const envelope = await store.get(vault, BROKER_COLLECTION, brokerId)
  if (!envelope) return null
  const record = JSON.parse(await openEnvelopeJson(envelope, dek)) as BrokerSeedRecord
  return { envelope, record }
}

async function persistRecord(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  dek: EnclaveKey,
  record: BrokerSeedRecord,
  expectedVersion: number,
): Promise<void> {
  const envelope = buildSealedRecordEnvelope(
    { collection: BROKER_COLLECTION, id: record.brokerId, by: keyring.userId },
    await writeEnvelopeBody(JSON.stringify(record), dek),
    { version: expectedVersion + 1, by: keyring.userId },
  )
  await store.put(vault, BROKER_COLLECTION, record.brokerId, envelope, expectedVersion)
}

interface SeedState {
  readonly seedBytes: Uint8Array
  readonly record: BrokerSeedRecord
  readonly dek: EnclaveKey
  readonly version: number
}

/** Create-if-absent CAS (I4/V20): a concurrent enrol that loses the race
 *  re-reads the winner's seed instead of persisting a second one. */
async function ensureSeedRecord(store: NoydbStore, vault: string, keyring: UnlockedKeyring, config: BrokerConfig): Promise<SeedState> {
  requireAdminAccess(keyring)
  const dek = await brokerDek(store, vault, keyring)

  const existing = await readRecord(store, vault, config.brokerId, dek)
  if (existing) {
    return { seedBytes: base64ToBuffer(existing.record.seed), record: existing.record, dek, version: existing.envelope._v }
  }

  const seedBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const record: BrokerSeedRecord = {
    brokerId: config.brokerId,
    seed: bufferToBase64(seedBytes),
    endpoint: config.endpoint,
    createdAt: new Date().toISOString(),
    registered: false,
  }
  try {
    await persistRecord(store, vault, keyring, dek, record, 0)
    return { seedBytes, record, dek, version: 1 }
  } catch (err) {
    if (!(isConflictError(err))) throw err
    const winner = await readRecord(store, vault, config.brokerId, dek)
    if (!winner) throw err
    return { seedBytes: base64ToBuffer(winner.record.seed), record: winner.record, dek, version: winner.envelope._v }
  }
}

async function postEnroll(config: BrokerConfig, vault: string, proofBits: Uint8Array): Promise<void> {
  const fetchFn = config.fetch ?? globalThis.fetch
  const attestation = config.attestation ? await config.attestation() : undefined
  let res: Response
  try {
    res = await fetchFn(`${config.endpoint}/enroll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(attestation !== undefined ? { authorization: `Bearer ${attestation}` } : {}),
      },
      body: JSON.stringify({ vaultId: vault, brokerId: config.brokerId, proofKey: bufferToBase64(proofBits) }),
    })
  } catch (err) {
    throw new BrokerEnrolmentError(`broker /enroll request failed: ${(err as Error).message}`)
  }
  if (!res.ok) {
    throw new BrokerEnrolmentError(`broker refused enrolment (status ${res.status}) — attestation likely missing or invalid`)
  }
}

/**
 * Enrol (idempotent, two-phase commit — I9): create-if-absent the `_broker`
 * seed (I4), derive+register its proof key with the broker host, and only
 * on a 2xx mark the record `registered: true`. Requires owner/admin role
 * and (for first-seed creation only) the KEK.
 */
export async function enrollSeed(ctx: BrokerSeedCtx): Promise<void> {
  const { store, vault, keyring, config } = ctx
  const { seedBytes, record, dek, version } = await ensureSeedRecord(store, vault, keyring, config)
  if (record.registered) {
    seedBytes.fill(0)
    return
  }

  const proofBits = await deriveBrokerProofBits(seedBytes, vault, config.brokerId)
  seedBytes.fill(0)
  try {
    await postEnroll(config, vault, proofBits)
  } finally {
    proofBits.fill(0)
  }

  try {
    await persistRecord(store, vault, keyring, dek, { ...record, registered: true }, version)
  } catch (err) {
    if (isConflictError(err)) {
      const latest = await readRecord(store, vault, config.brokerId, dek)
      if (latest?.record.registered) return // a concurrent enrol already committed the same outcome
    }
    throw err
  }
}

/**
 * Rotate (quiesce-then-swap — I5): mint a fresh seed, register its proof
 * key with the broker host FIRST, then overwrite the local `_broker`
 * record. The broker host is expected to accept both the old and new
 * registration for a short grace window, so an in-flight proof computed
 * under the old key (from before rotation started) still verifies. Cache
 * quiescing (awaiting any in-flight round-trip, bumping the refresh-cache
 * epoch) is the caller's job — `with-party/broker/active.ts` — since the
 * cache lives in that closure, not here.
 */
export async function rotateSeed(ctx: BrokerSeedCtx): Promise<void> {
  const { store, vault, keyring, config } = ctx
  requireAdminAccess(keyring)
  const dek = await brokerDek(store, vault, keyring)

  const existing = await readRecord(store, vault, config.brokerId, dek)
  if (!existing) {
    // Nothing to rotate yet — behaves like a first enrol.
    await enrollSeed(ctx)
    return
  }

  const newSeedBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const newProofBits = await deriveBrokerProofBits(newSeedBytes, vault, config.brokerId)
  try {
    await postEnroll(config, vault, newProofBits)
  } finally {
    newProofBits.fill(0)
  }

  const record: BrokerSeedRecord = {
    brokerId: config.brokerId,
    seed: bufferToBase64(newSeedBytes),
    endpoint: config.endpoint,
    createdAt: new Date().toISOString(),
    registered: true,
  }
  newSeedBytes.fill(0)
  await persistRecord(store, vault, keyring, dek, record, existing.envelope._v)
}

/**
 * The challenge/response round trip: `POST /challenge`, derive+sign the
 * proof from the decrypted seed, `POST /credentials`. One network round
 * trip per call — the single-flight/cache wrapping lives in `active.ts`.
 *
 * Fails fast with {@link BrokerEnrolmentError} if the seed hasn't completed
 * enrolment yet (`registered !== true` — I9/V23), never degrading into an
 * opaque {@link BrokerProofError}.
 */
export async function mintStoreCredentials(ctx: BrokerSeedCtx, profile?: string): Promise<StoreCredentials> {
  const { store, vault, keyring, config } = ctx
  requireAdminAccess(keyring)
  const dek = await brokerDek(store, vault, keyring)

  const found = await readRecord(store, vault, config.brokerId, dek)
  if (!found) throw new BrokerEnrolmentError(`No _broker seed enrolled for brokerId "${config.brokerId}" — call enroll() first.`)
  if (!found.record.registered) {
    throw new BrokerEnrolmentError(
      `The _broker seed for "${config.brokerId}" has not completed enrolment with the broker host — call enroll() again.`,
    )
  }

  const fetchFn = config.fetch ?? globalThis.fetch
  const endpointOrigin = new URL(config.endpoint).origin

  let challengeRes: Response
  try {
    challengeRes = await fetchFn(`${config.endpoint}/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vaultId: vault, brokerId: config.brokerId }),
    })
  } catch (err) {
    throw new NetworkError(`broker /challenge request failed: ${(err as Error).message}`)
  }
  if (!challengeRes.ok) throw new NetworkError(`broker /challenge failed with status ${challengeRes.status}`)
  const { challenge, expiresAt } = (await challengeRes.json()) as { challenge: string; expiresAt: string }

  const seedBytes = base64ToBuffer(found.record.seed)
  const proof = await computeBrokerProof(seedBytes, vault, config.brokerId, { endpointOrigin, profile, challenge, expiresAt })

  let credsRes: Response
  try {
    credsRes = await fetchFn(`${config.endpoint}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vaultId: vault, brokerId: config.brokerId, challenge, proof, ...(profile !== undefined ? { profile } : {}) }),
    })
  } catch (err) {
    throw new NetworkError(`broker /credentials request failed: ${(err as Error).message}`)
  }
  if (credsRes.status === 401 || credsRes.status === 403) throw new BrokerProofError('broker rejected the challenge proof')
  if (!credsRes.ok) throw new NetworkError(`broker /credentials failed with status ${credsRes.status}`)
  return (await credsRes.json()) as StoreCredentials
}
