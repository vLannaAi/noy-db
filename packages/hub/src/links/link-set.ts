/**
 * `_links_*` reserved collections — managed bidirectional many-to-many
 * junctions (#377 design B).
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

import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import type { NoydbEventEmitter } from '../events.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { NoydbError } from '../errors.js'

export const LINK_COLLECTION_PREFIX = '_links_'

/** Storage collection name for a logical link set. */
export function linkCollectionName(name: string): string {
  return `${LINK_COLLECTION_PREFIX}${name}`
}

/** True for any reserved link-collection name. */
export function isLinkCollectionName(name: string): boolean {
  return name.startsWith(LINK_COLLECTION_PREFIX)
}

/** What happens to a link's rows when one of its endpoint records is deleted. */
export type LinkOnDelete = 'cascade' | 'strict' | 'warn'

/**
 * Declaration for a link set, passed to `vault.link(name, spec)`. `a` and
 * `b` are the endpoint collection names (slot-typed). `onDelete` governs
 * what happens to link rows when an endpoint record is deleted:
 * `'cascade'` (default) removes the touching link rows, `'strict'` blocks
 * the endpoint delete while links exist, `'warn'` leaves orphan rows
 * (surfaced by `vault.checkIntegrity()`).
 */
export interface LinkSpec {
  readonly a: string
  readonly b: string
  readonly onDelete?: LinkOnDelete
}

/** One link tuple as returned by `of()` / `list()`. */
export interface LinkRow {
  readonly a: string
  readonly b: string
  readonly meta?: Record<string, unknown>
}

/** Stored form (also the row key derivation source). */
interface LinkEntry {
  a: string
  b: string
  meta?: Record<string, unknown>
}

/**
 * Compose the row key for an ordered `(a, b)` pair. Each id is
 * URI-encoded and joined with `|` — encodeURIComponent escapes `|`, so the
 * key is unambiguous regardless of id contents.
 */
export function linkRowKey(aId: string, bId: string): string {
  return `${encodeURIComponent(aId)}|${encodeURIComponent(bId)}`
}

/** Public handle returned by `vault.links(name)`. */
export interface LinkSetHandle {
  /** Create (or overwrite the metadata of) the link `(aId, bId)`. Validates both endpoints exist. */
  connect(aId: string, bId: string, meta?: Record<string, unknown>): Promise<void>
  /** Remove the link `(aId, bId)`. Idempotent — a no-op if it doesn't exist. */
  disconnect(aId: string, bId: string): Promise<void>
  /** Whether the link `(aId, bId)` exists. */
  has(aId: string, bId: string): Promise<boolean>
  /** All links touching `id` on EITHER endpoint. */
  of(id: string): Promise<LinkRow[]>
  /** All links in the set. */
  list(): Promise<LinkRow[]>
}

/**
 * @internal — the concrete handle. The Vault owns construction (one per
 * link name) and the cascade hooks; consumers use the {@link LinkSetHandle}
 * surface via `vault.links(name)`.
 */
export class LinkSet implements LinkSetHandle {
  private readonly collName: string
  private dekPromise: Promise<CryptoKey> | null = null

  constructor(
    private readonly adapter: NoydbStore,
    private readonly vault: string,
    private readonly name: string,
    private readonly spec: LinkSpec,
    private readonly encrypted: boolean,
    private readonly getDEK: (collectionName: string) => Promise<CryptoKey>,
    private readonly actor: string,
    private readonly emitter: NoydbEventEmitter,
    /** Vault-provided existence check for endpoint validation on connect(). */
    private readonly endpointExists: (collection: string, id: string) => Promise<boolean>,
  ) {
    this.collName = linkCollectionName(name)
  }

  private dek(): Promise<CryptoKey> {
    if (!this.dekPromise) this.dekPromise = this.getDEK(this.collName)
    return this.dekPromise
  }

  private async encryptEntry(entry: LinkEntry, version: number): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(entry)
    const base = { _noydb: NOYDB_FORMAT_VERSION, _v: version, _ts: new Date().toISOString(), _by: this.actor }
    if (!this.encrypted) return { ...base, _iv: '', _data: json }
    const { iv, data } = await encrypt(json, await this.dek())
    return { ...base, _iv: iv, _data: data }
  }

  private async decryptEntry(env: EncryptedEnvelope): Promise<LinkEntry> {
    const json = this.encrypted ? await decrypt(env._iv, env._data, await this.dek()) : env._data
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
    const env = await this.encryptEntry(entry, (existing?._v ?? 0) + 1)
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
      const e = await this.decryptEntry(env)
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

/** Thrown when a `strict` link blocks deletion of an endpoint that still has links. */
export class LinkIntegrityError extends NoydbError {
  readonly link: string
  readonly endpoint: string
  readonly id: string
  readonly count: number
  constructor(link: string, endpoint: string, id: string, count: number) {
    super(
      'LINK_INTEGRITY',
      `Cannot delete "${endpoint}"/"${id}": ${count} link(s) in "${link}" still reference it (onDelete: 'strict').`,
    )
    this.name = 'LinkIntegrityError'
    this.link = link
    this.endpoint = endpoint
    this.id = id
    this.count = count
  }
}
