/**
 * Collection-level search / retrieval (`search` / `retrieve` / `similarTo` +
 * the lexical-index build/flush/warm machinery), lifted off the `Collection`
 * god-object (Phase 5 A14 of the microkernel refactoring).
 *
 * This is the #308 retrieval surface: a pure client-side lexical scan
 * (`search`), the persisted-or-in-memory inverted-index lifecycle
 * (`flushIndex` / `warmIndex` / `buildRetrievalDocs` + the dict-label / blob-
 * filename resolvers that feed it), and the lexical / semantic / hybrid
 * `retrieve` fan-out plus raw-vector kNN (`similarTo`). None of it touches the
 * write path — it reads the live eager cache and the encrypted `_vec` / `_ftindex`
 * side-cars.
 *
 * Every function takes a small {@link SearchContext} (the exact `this.*` the
 * moving methods touched) instead of `this`, mirroring the `record-keys/`
 * siblings. Behaviour is byte-identical to the inline code it replaced.
 *
 * The `cache` is the SAME `Map` reference `Collection` owns (passed by
 * reference, never copied) so the index always builds over the live working
 * set. {@link buildPersistedIndexCallbacks} is special: it is invoked from the
 * `Collection` constructor *before* `this.codec` exists, so it takes a context
 * THUNK and resolves the context lazily at each callback invocation.
 *
 * Internal subsystem — not exported as a `@noy-db/hub/*` subpath.
 */
import type { NoydbStore } from '../../kernel/types.js'
import type { RecordCodec } from '../../kernel/enclave/record-keys/record-codec.js'
import { stripI18nFilled, type I18nTextDescriptor } from '../../with-shape/i18n/core.js'
import { isStaticDictDescriptor, type DictKeyDescriptor, type StaticDictDescriptor, type DictionaryHandle } from '../../with-shape/i18n/dictionary.js'
import type { BlobSet } from '../../with-shape/blobs/blob-set.js'
import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'
import type { Query } from '../../kernel/query/index.js'
import type { VectorSet, EmbeddingDescriptor, StoredVector } from '../embeddings/index.js'
import { searchScan, fuseRetrieval, type SearchOptions, type SearchResult } from './index.js'
import type { IndexStore } from './index-store.js'
import type { PersistedIndexCallbacks } from './persisted-index-store.js'
import { extractSnippet } from './snippet.js'
import { buildStringFieldEntries, buildI18nFieldEntries, buildDictKeyFieldEntries, buildBlobFieldEntries } from './build-docs.js'
import type { IndexDoc, IndexHit } from './inverted-index.js'
import type { RetrieveOptions, RetrieveHit } from './retrieve-types.js'

/** Everything the moving search/retrieval methods touched on `this.*`. */
export interface SearchContext<T> {
  /** Collection name — error context + `_ftindex` row key. */
  readonly name: string
  /** Vault namespace the side-cars (`_vec`, `_ftindex`) live under. */
  readonly vault: string
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** The record codec — decrypts the `_vec` / `_ftindex` side-car bodies. */
  readonly codec: RecordCodec<T>
  /** The eager working-set cache (SHARED `Map` reference, never copied). */
  readonly cache: Map<string, { record: T; version: number }>
  /** True in lazy mode — search/retrieve/warm require eager mode. */
  readonly lazy: boolean
  /** Declared text-index fields, or undefined. */
  readonly textIndexes: readonly string[] | undefined
  /** Declared i18n fields, or undefined. */
  readonly i18nFields: Record<string, I18nTextDescriptor> | undefined
  /** Declared dictionary-key fields, or undefined. */
  readonly dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  /** Declared blob fields, or undefined. */
  readonly blobFields: BlobFieldsConfig | undefined
  /** Dictionary handle resolver (dynamic dict-key labels), or undefined. */
  readonly getDictionary: ((name: string) => Promise<DictionaryHandle>) | undefined
  /** The lexical inverted-index store (in-memory or persisted), or undefined. */
  readonly searchIndexStore: IndexStore | undefined
  /** The vector set for semantic retrieval, or undefined. */
  readonly vectorSet: VectorSet | undefined
  /** The embeddings descriptor, or undefined. */
  readonly embeddings: EmbeddingDescriptor | undefined
  /** Hydrate the eager cache before reading it. */
  ensureHydrated(): Promise<void>
  /** Open the blob facade for a record (used to list indexed blob filenames). */
  blob(id: string): BlobSet
}

/**
 * #308 — client-side lexical scan over the live eager cache. Eager mode only;
 * nothing searchable is written to the store.
 */
export async function search<T>(ctx: SearchContext<T>, field: string, query: string, opts: SearchOptions = {}): Promise<SearchResult<T>[]> {
  if (ctx.lazy) {
    throw new Error(
      `Collection "${ctx.name}": search() (scan mode) requires eager mode (prefetch: true). ` +
        `A store-usable blind index for lazy / at-scale search is a separate gated opt-in (#308).`,
    )
  }
  await ctx.ensureHydrated()
  const entries: { id: string; record: T }[] = []
  // #435 — strip the internal densify marker from the user-facing records.
  // Non-mutating: never touches the cached record object. The search index
  // is built over the same (marker-free) record, which is fine — the marker
  // is never a searchable field.
  for (const [id, e] of ctx.cache) entries.push({ id, record: stripI18nFilled(e.record as Record<string, unknown>) as T })
  return searchScan(entries, field, query, opts)
}

/** #308 L1 — build IndexDoc[] for the configured text fields over the live cache. */
export function buildRetrievalDocs<T>(
  ctx: SearchContext<T>,
  labelMaps: Map<string, Map<string, Record<string, string>>>,
  blobFilenames: Map<string, Map<string, string[]>>,
  only?: readonly string[],
): IndexDoc[] {
  const docs: IndexDoc[] = []
  for (const [id, e] of ctx.cache) {
    const rec = stripI18nFilled(e.record as Record<string, unknown>)
    const fields = buildStringFieldEntries(rec, ctx.textIndexes ?? [], only)
    if (ctx.i18nFields) fields.push(...buildI18nFieldEntries(rec, ctx.i18nFields, ctx.textIndexes ?? [], only))
    if (ctx.dictKeyFields) fields.push(...buildDictKeyFieldEntries(rec, ctx.dictKeyFields, labelMaps, ctx.textIndexes ?? [], only))
    const blobNames = blobFilenames.get(id)
    if (blobNames) fields.push(...buildBlobFieldEntries(blobNames))
    if (fields.length > 0) docs.push({ id, fields })
  }
  return docs
}

/** #308 L1 — true iff any configured text index is also a blob field (gates ALL slot I/O). */
export function hasIndexedBlobFields<T>(ctx: SearchContext<T>, only?: readonly string[]): boolean {
  if (!ctx.blobFields || !ctx.textIndexes) return false
  const fields = only ? ctx.textIndexes.filter((f) => only.includes(f)) : ctx.textIndexes
  return fields.some((f) => f in ctx.blobFields!)
}

/**
 * #308 L1 — resolve `recordId -> (blobField -> filenames[])` by listing slots
 * for the configured blob fields of each cached record. Blob slot metadata is
 * NOT inline on the record: it lives in a separate `_blob_slots_*` collection,
 * so this costs ONE `blob(id).list()` (a `listSlots`) per record at build time
 * — the heaviest indexing source. Fully gated by {@link hasIndexedBlobFields};
 * non-blob (and blob-but-not-indexed) collections do ZERO slot I/O.
 */
async function resolveBlobFilenames<T>(ctx: SearchContext<T>, only?: readonly string[]): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>()
  if (!hasIndexedBlobFields(ctx, only)) return out
  const indexed = (only ? ctx.textIndexes!.filter((f) => only.includes(f)) : ctx.textIndexes!)
    .filter((f) => f in ctx.blobFields!)
  const indexedSet = new Set(indexed)
  for (const id of ctx.cache.keys()) {
    let slots
    try {
      slots = await ctx.blob(id).list()
    } catch {
      continue
    }
    let byField: Map<string, string[]> | undefined
    for (const slot of slots) {
      if (!indexedSet.has(slot.name) || !slot.filename) continue
      if (!byField) { byField = new Map(); out.set(id, byField) }
      const names = byField.get(slot.name)
      if (names) names.push(slot.filename)
      else byField.set(slot.name, [slot.filename])
    }
  }
  return out
}

/** #308 L1 — field -> (key -> {locale->label}) for dictKey fields; static from table, dynamic via getDictionary().list(). */
async function resolveDictLabelMaps<T>(ctx: SearchContext<T>): Promise<Map<string, Map<string, Record<string, string>>>> {
  const maps = new Map<string, Map<string, Record<string, string>>>()
  if (!ctx.dictKeyFields || !ctx.textIndexes) return maps
  for (const field of ctx.textIndexes) {
    const desc = ctx.dictKeyFields[field]
    if (!desc) continue
    const m = new Map<string, Record<string, string>>()
    if (isStaticDictDescriptor(desc)) {
      for (const [key, labels] of Object.entries(desc.table)) m.set(key, labels as Record<string, string>)
    } else {
      if (ctx.getDictionary) {
        const handle = await ctx.getDictionary(desc.name)
        for (const e of await handle.list()) m.set(e.key, e.labels)
      }
    }
    maps.set(field, m)
  }
  return maps
}

/** #308 L1.5 — force-persist the lexical index now (e.g. on save/idle). Persists only when textIndexPersist is enabled; a no-op otherwise. */
export async function flushIndex<T>(ctx: SearchContext<T>): Promise<void> {
  if (!ctx.searchIndexStore) return
  await ctx.ensureHydrated()
  const labelMaps = await resolveDictLabelMaps(ctx)
  const blobFilenames = await resolveBlobFilenames(ctx)
  await ctx.searchIndexStore.ensureBuilt(() => buildRetrievalDocs(ctx, labelMaps, blobFilenames))
  await ctx.searchIndexStore.flush?.()
}

/** #308 L2 — load + decrypt all _vec sidecars into StoredVector[] for the VectorSet. */
function buildVectorLoad<T>(ctx: SearchContext<T>): () => Promise<StoredVector[]> {
  return async () => {
    const ids = await ctx.adapter.list(ctx.vault, '_vec')
    const out: StoredVector[] = []
    for (const id of ids) {
      const env = await ctx.adapter.get(ctx.vault, '_vec', id)
      if (!env) continue
      const body = await ctx.codec.decryptJsonString(env)
      if (body === null) continue
      const parsed = JSON.parse(body) as { vec: number[]; model: string }
      out.push({ id, vec: new Float32Array(parsed.vec), model: parsed.model })
    }
    return out
  }
}

/**
 * #308 L1.5 — build the PersistedIndexCallbacks bridge: crypto lives here
 * (collection has getDEK / encryptJsonString / decryptJsonString / adapter),
 * the index store itself is crypto-free.
 *
 * Fingerprint encoding: body-wrap approach — save(json, fp) stores
 * JSON.stringify({ fp, idx: json }) as the encrypted body so the standard
 * EncryptedEnvelope shape is never extended. load() decrypts and JSON.parses
 * the wrapper back out.
 *
 * Cache shape: ctx.cache stores { record, version } — currentFingerprint()
 * iterates over e.version.
 *
 * NOTE: this factory is invoked from the `Collection` constructor *before*
 * `this.codec` is assigned, so it takes a context THUNK and resolves the
 * context lazily inside each callback — by the time a callback actually runs,
 * the codec and cache are fully wired.
 */
export function buildPersistedIndexCallbacks<T>(provideCtx: () => SearchContext<T>): PersistedIndexCallbacks {
  const FT = '_ftindex'
  return {
    load: async () => {
      const ctx = provideCtx()
      const env = await ctx.adapter.get(ctx.vault, FT, ctx.name)
      if (!env) return null
      const body = await ctx.codec.decryptJsonString(env)
      if (body === null) return null
      try {
        const wrapped = JSON.parse(body) as { fp: { count: number; maxVersion: number }; idx: string }
        return { json: wrapped.idx, fingerprint: wrapped.fp }
      } catch {
        return null
      }
    },
    save: async (json, fp) => {
      const ctx = provideCtx()
      const body = JSON.stringify({ fp, idx: json })
      const env = await ctx.codec.encryptJsonString(body, fp.count)
      await ctx.adapter.put(ctx.vault, FT, ctx.name, env)
    },
    remove: async () => { const ctx = provideCtx(); await ctx.adapter.delete(ctx.vault, FT, ctx.name) },
    currentFingerprint: () => {
      const ctx = provideCtx()
      let maxVersion = 0
      for (const e of ctx.cache.values()) if (e.version > maxVersion) maxVersion = e.version
      return { count: ctx.cache.size, maxVersion }
    },
  }
}

/** #308 L1 — pre-build the lexical index (e.g. on open) so the first retrieve() pays no build scan. */
export async function warmIndex<T>(ctx: SearchContext<T>): Promise<void> {
  if (!ctx.searchIndexStore) return
  if (ctx.lazy) {
    throw new Error(
      `Collection "${ctx.name}": warmIndex() requires eager mode (prefetch: true).`,
    )
  }
  await ctx.ensureHydrated()
  const built = ctx.searchIndexStore.built
  const labelMaps = built ? new Map() : await resolveDictLabelMaps(ctx)
  const blobFilenames = built ? new Map() : await resolveBlobFilenames(ctx)
  await ctx.searchIndexStore.ensureBuilt(() => buildRetrievalDocs(ctx, labelMaps, blobFilenames))
}

/** #308 — retrieval. mode: 'lexical' (default) | 'semantic' (L2) | 'hybrid' (L3). */
export async function retrieve<T>(ctx: SearchContext<T>, query: string, opts: RetrieveOptions<T> = {}): Promise<RetrieveHit<T>[]> {
  const hits =
    opts.mode === 'semantic' ? await retrieveSemantic(ctx, query, opts)
    : opts.mode === 'hybrid' ? await retrieveHybrid(ctx, query, opts)
    : await retrieveLexical(ctx, query, opts)
  return opts.within ? applyWithin(hits, opts.within) : hits
}

/** #308 L3 — keep only hits whose id matches the structured query, re-rank 1-based. */
function applyWithin<T>(hits: RetrieveHit<T>[], within: Query<T>): RetrieveHit<T>[] {
  const ids = new Set(within._idArray())
  return hits.filter(h => ids.has(h.id)).map((h, i) => ({ ...h, rank: i + 1 }))
}

/** #308 L1 — client-side lexical retrieval; ranked { id, score, field, snippet, locale? }. */
async function retrieveLexical<T>(ctx: SearchContext<T>, query: string, opts: RetrieveOptions<T>): Promise<RetrieveHit<T>[]> {
  if (!ctx.searchIndexStore) {
    throw new Error(`Collection "${ctx.name}": retrieve() requires a textIndexes config.`)
  }
  if (ctx.lazy) {
    throw new Error(
      `Collection "${ctx.name}": retrieve() requires eager mode (prefetch: true).`,
    )
  }
  await ctx.ensureHydrated()
  const built = ctx.searchIndexStore.built
  const labelMaps = built ? new Map() : await resolveDictLabelMaps(ctx)
  const blobFilenames = built ? new Map() : await resolveBlobFilenames(ctx)
  const index = await ctx.searchIndexStore.ensureBuilt(() => buildRetrievalDocs(ctx, labelMaps, blobFilenames))
  const hits = index.query(query, {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.match ? { match: opts.match } : {}),
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
    ...(opts.fields ? { fields: opts.fields } : {}),
  })
  const window = opts.snippetWindow ?? 80
  return hits.map((h: IndexHit, i: number) => {
    const base: RetrieveHit<T> = {
      id: h.id,
      score: h.score,
      rank: i + 1,
      field: h.field,
      snippet: extractSnippet(h.text, h.offset, window),
      ...(h.locale !== undefined ? { locale: h.locale } : {}),
      ...(opts.includeRecord
        ? (() => {
            const e = ctx.cache.get(h.id)
            return e ? { record: stripI18nFilled(e.record as Record<string, unknown>) as T } : {}
          })()
        : {}),
    }
    return base
  })
}

/** #308 L3 — hybrid: fuse lexical (L1) + semantic (L2) by RRF. Requires embeddings. */
async function retrieveHybrid<T>(ctx: SearchContext<T>, query: string, opts: RetrieveOptions<T>): Promise<RetrieveHit<T>[]> {
  if (!ctx.embeddings) {
    throw new Error(`Collection "${ctx.name}": retrieve({mode:'hybrid'}) requires an embeddings config.`)
  }
  const [lex, sem] = await Promise.all([
    retrieveLexical(ctx, query, opts),
    retrieveSemantic(ctx, query, opts),
  ])
  return fuseRetrieval([lex, sem], opts.limit !== undefined ? { limit: opts.limit } : {})
}

/** #308 L2 — semantic branch of retrieve(): encode query → similarTo(). */
async function retrieveSemantic<T>(ctx: SearchContext<T>, query: string, opts: RetrieveOptions<T>): Promise<RetrieveHit<T>[]> {
  if (!ctx.embeddings) throw new Error(`Collection "${ctx.name}": retrieve({mode:'semantic'}) requires an embeddings config.`)
  if (ctx.lazy) throw new Error(`Collection "${ctx.name}": retrieve() requires eager mode (prefetch: true).`)
  const qVec = await ctx.embeddings.encode(query)
  return similarTo(ctx, qVec, {
    ...(opts.limit !== undefined ? { k: opts.limit } : {}),
    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
    ...(opts.includeRecord ? { includeRecord: true } : {}),
  })
}

/** #308 L2 — raw-vector kNN over the encrypted vector set (decrypted in the trusted tier).
 *  Snippet is '' for vector hits in v1 (semantic match isn't span-located). */
export async function similarTo<T>(ctx: SearchContext<T>, vector: Float32Array, opts: { k?: number; minScore?: number; includeRecord?: boolean } = {}): Promise<RetrieveHit<T>[]> {
  if (!ctx.embeddings || !ctx.vectorSet) throw new Error(`Collection "${ctx.name}": similarTo() requires an embeddings config.`)
  if (ctx.lazy) throw new Error(`Collection "${ctx.name}": similarTo() requires eager mode (prefetch: true).`)
  await ctx.ensureHydrated()
  await ctx.vectorSet.ensureLoaded(buildVectorLoad(ctx))
  const hits = ctx.vectorSet.cosineTopK(vector, opts.k ?? 10, {
    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
    expectModel: ctx.embeddings.model,
  })
  return hits.map((h, i) => {
    const base: RetrieveHit<T> = { id: h.id, score: h.score, rank: i + 1, field: '(vector)', snippet: '' }
    if (opts.includeRecord) { const e = ctx.cache.get(h.id); if (e) (base as { record?: T }).record = stripI18nFilled(e.record as Record<string, unknown>) as T }
    return base
  })
}
