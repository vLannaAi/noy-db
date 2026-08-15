/**
 * `_links_*` reserved collections — managed bidirectional many-to-many
 * junctions (design B).
 *
 * Where `refArray` (design A) stores an id-array on one owning record,
 * `vault.link()` creates a first-class junction: a dedicated encrypted
 * `_links_<name>` collection whose rows are `{ a, b, meta? }` link tuples.
 * It is queryable from BOTH sides (`of(id)`), carries optional per-link
 * metadata, and cascades on endpoint delete.
 *
 * Each link is slot-typed: `a` is an id in the `a` endpoint collection,
 * `b` an id in the `b` endpoint collection (they may be the same
 * collection for self-links). A link's identity is the ordered pair
 * `(a, b)`; `of(id)` matches either slot.
 *
 * Rows are encrypted under a dedicated `_links_<name>` DEK — same
 * zero-knowledge stack as every other collection (the store sees only
 * ciphertext). Backup/restore rides the normal `loadAll` path.
 */

import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import { buildRecordEnvelope, encrypt, openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'
import { NoydbError } from '../../kernel/errors.js'

// Naming helpers, declaration types, and LinkIntegrityError live in
// `names.ts` (the always-loadable slice — #553); re-exported here so
// existing import paths and the root barrel are unchanged.
export {
  LINK_COLLECTION_PREFIX,
  linkCollectionName,
  isLinkCollectionName,
  linkRowKey,
  LinkIntegrityError,
} from './names.js'
export type { LinkOnDelete, LinkSpec, LinkRow, LinkSetHandle } from './names.js'
import { linkCollectionName, linkRowKey } from './names.js'
import type { LinkSpec, LinkRow, LinkSetHandle } from './names.js'

/** Stored form (also the row key derivation source). */
interface LinkEntry {
  a: string
  b: string
  meta?: Record<string, unknown>
}

/**
 * @internal — the concrete handle. The Vault owns construction (one per
 * link name) and the cascade hooks; consumers use the {@link LinkSetHandle}
 * surface via `vault.links(name)`.
 */
export class LinkSet implements LinkSetHandle {
  private readonly collName: string
  private dekPromise: Promise<EnclaveKey> | null = null

  constructor(
    private readonly adapter: NoydbStore,
    private readonly vault: string,
    private readonly name: string,
    private readonly spec: LinkSpec,
    private readonly encrypted: boolean,
    private readonly getDEK: (collectionName: string) => Promise<EnclaveKey>,
    private readonly actor: string,
    private readonly emitter: NoydbEventEmitter,
    /** Vault-provided existence check for endpoint validation on connect(). */
    private readonly endpointExists: (collection: string, id: string) => Promise<boolean>,
  ) {
    this.collName = linkCollectionName(name)
  }

  private dek(): Promise<EnclaveKey> {
    if (!this.dekPromise) this.dekPromise = this.getDEK(this.collName)
    return this.dekPromise
  }

  private async encryptEntry(entry: LinkEntry, version: number, key: string): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(entry)
    const identity = { collection: this.collName, id: key, by: this.actor }
    if (!this.encrypted) {
      return buildRecordEnvelope(identity, { version, iv: '', data: json})
    }
    const { iv, data } = await encrypt(json, await this.dek())
    return buildRecordEnvelope(identity, { version, iv, data})
  }

  private async decryptEntry(key: string, env: EncryptedEnvelope): Promise<LinkEntry> {
    const json = this.encrypted ? await openEnvelopeJson({ collection: this.collName, id: key }, env, await this.dek()) : env._data
    return JSON.parse(json) as LinkEntry
  }

  async connect(aId: string, bId: string, meta?: Record<string, unknown>): Promise<void> {
    if (!(await this.endpointExists(this.spec.a, aId))) {
      throw new LinkEndpointError(this.name, this.spec.a, aId)
    }
    if (!(await this.endpointExists(this.spec.b, bId))) {
      throw new LinkEndpointError(this.name, this.spec.b, bId)
    }
    const key = linkRowKey(aId, bId)
    const entry: LinkEntry = meta !== undefined ? { a: aId, b: bId, meta } : { a: aId, b: bId }
    const existing = await this.adapter.get(this.vault, this.collName, key)
    const env = await this.encryptEntry(entry, (existing?._v ?? 0) + 1, key)
    await this.adapter.put(this.vault, this.collName, key, env, existing?._v)
    this.emitter.emit('change', { vault: this.vault, collection: this.collName, id: key, action: 'put' })
  }

  async disconnect(aId: string, bId: string): Promise<void> {
    const key = linkRowKey(aId, bId)
    const existing = await this.adapter.get(this.vault, this.collName, key)
    if (!existing) return
    await this.adapter.delete(this.vault, this.collName, key)
    this.emitter.emit('change', { vault: this.vault, collection: this.collName, id: key, action: 'delete' })
  }

  async has(aId: string, bId: string): Promise<boolean> {
    return (await this.adapter.get(this.vault, this.collName, linkRowKey(aId, bId))) !== null
  }

  async of(id: string): Promise<LinkRow[]> {
    const rows = await this.list()
    return rows.filter((r) => r.a === id || r.b === id)
  }

  async list(): Promise<LinkRow[]> {
    const keys = await this.adapter.list(this.vault, this.collName)
    const out: LinkRow[] = []
    for (const key of keys) {
      const env = await this.adapter.get(this.vault, this.collName, key)
      if (!env) continue
      const e = await this.decryptEntry(key, env)
      out.push(e.meta !== undefined ? { a: e.a, b: e.b, meta: e.meta } : { a: e.a, b: e.b })
    }
    return out
  }

  // ── Vault-internal cascade helpers ──────────────────────────────────

  /** @internal — rows where the deleted endpoint id matches the relevant slot. */
  async _rowsTouchingEndpoint(collection: string, id: string): Promise<LinkRow[]> {
    const rows = await this.list()
    return rows.filter(
      (r) => (this.spec.a === collection && r.a === id) || (this.spec.b === collection && r.b === id),
    )
  }

  /** @internal — the storage collection name (for tx pre-image capture). */
  get _collectionName(): string {
    return this.collName
  }
}

/** Thrown by `connect()` when an endpoint record does not exist. */
export class LinkEndpointError extends NoydbError {
  readonly link: string
  readonly endpoint: string
  readonly missingId: string
  constructor(link: string, endpoint: string, missingId: string) {
    super(
      'LINK_ENDPOINT',
      `link("${link}").connect: endpoint "${endpoint}" has no record "${missingId}".`,
    )
    this.name = 'LinkEndpointError'
    this.link = link
    this.endpoint = endpoint
    this.missingId = missingId
  }
}
