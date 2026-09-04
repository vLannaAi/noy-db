/**
 * Collection-level search / retrieval (`search` / `retrieve` / `similarTo` +
 * the lexical-index build/flush/warm machinery).
 *
 * This is the retrieval surface: a pure client-side lexical scan
 * (`search`), the persisted-or-in-memory inverted-index lifecycle
 * (`flushIndex` / `warmIndex` / `buildRetrievalDocs` + the dict-label / blob-
 * filename resolvers that feed it), and the lexical / semantic / hybrid
 * `retrieve` fan-out plus raw-vector kNN (`similarTo`). None of it touches the
 * write path — it reads the live eager cache and the encrypted `_vec` / `_ftindex`
 * side-cars.
 *
 * Every function takes a small {@link SearchContext} instead of `this`,
 * mirroring the `record-keys/` siblings.
 *
 * The `cache` is the SAME `Map` reference `Collection` owns (passed by
 * reference, never copied) so the index always builds over the live working
 * set. {@link buildPersistedIndexCallbacks} is special: it is invoked from the
 * `Collection` constructor *before* `this.codec` exists, so it takes a context
 * THUNK and resolves the context lazily at each callback invocation.
 *
 * Internal service — not exported as a `@noy-db/hub/*` subpath.
 */
import type { NoydbStore } from '../../kernel/types.js'
import type { RecordCodec } from '../../kernel/enclave/index.js'
import { stripI18nFilled, type I18nTextDescriptor } from '../../via/i18n/core.js'
import { isStaticDictDescriptor, type DictKeyDescriptor, type StaticDictDescriptor, type DictionaryHandle } from '../../via/i18n/dictionary.js'
import type { BlobSet } from '../../with-shape/blobs/blob-set.js'
import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'
import type { Query } from '../../kernel/query/index.js'
import { embeddingSourceText, deriveChunkVectors, type VectorSet, type EmbeddingDescriptor, type StoredVector, type StoredChunk } from '../embeddings/index.js'
import { encodeVecId, decodeVecId, isVecIdFor } from '../embeddings/vec-id.js'
import { EmbeddingDimMismatchError } from '../../kernel/errors.js'
import { liveRecordIsElevated } from '../../kernel/tier-visibility.js'
import { searchScan, fuseRetrieval, segmentTokenizer, type SearchOptions, type SearchResult } from './index.js'
import type { IndexStore } from './index-store.js'
import type { PersistedIndexCallbacks } from './persisted-index-store.js'
import { extractSnippet } from './snippet.js'
import { buildStringFieldEntries, buildI18nFieldEntries, buildDictKeyFieldEntries, buildBlobFieldEntries } from './build-docs.js'
import type { IndexDoc, IndexHit, IndexBuildOptions } from './inverted-index.js'
import type { RetrieveOptions, RetrieveHit, SimilarToOptions } from './retrieve-types.js'

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
  /** Subset of `textIndexes` recording token positions for phrase / proximity (#1354). */
  readonly textIndexPositions: readonly string[] | undefined
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
 * Client-side lexical scan over the live eager cache. Eager mode only;
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
  // Strip the internal densify marker from the user-facing records.
  // Non-mutating: never touches the cached record object. The search index
  // is built over the same (marker-free) record, which is fine — the marker
  // is never a searchable field.
  for (const [id, e] of ctx.cache) entries.push({ id, record: stripI18nFilled(e.record as Record<string, unknown>) as T })
  return searchScan(entries, field, query, opts)
}

/** L1 — build IndexDoc[] for the configured text fields over the live cache. */
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

/**
 * L1 — the positional-postings opt-in for this collection (#1354), or
 * `undefined` when nothing opted in. Returning `undefined` rather than
 * `{ positions: [] }` keeps the no-opt-in path byte-identical to a caller that
 * never heard of positions.
 */
export function positionBuildOptions<T>(ctx: SearchContext<T>): IndexBuildOptions | undefined {
  const fields = ctx.textIndexPositions
  return fields && fields.length > 0 ? { positions: fields } : undefined
}

/** L1 — true iff any configured text index is also a blob field (gates ALL slot I/O). */
export function hasIndexedBlobFields<T>(ctx: SearchContext<T>, only?: readonly string[]): boolean {
  if (!ctx.blobFields || !ctx.textIndexes) return false
  const fields = only ? ctx.textIndexes.filter((f) => only.includes(f)) : ctx.textIndexes
  return fields.some((f) => f in ctx.blobFields!)
}

/**
 * L1 — resolve `recordId -> (blobField -> filenames[])` by listing slots
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

/** L1 — field -> (key -> {locale->label}) for dictKey fields; static from table, dynamic via getDictionary().list(). */
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

/** L1.5 — force-persist the lexical index now (e.g. on save/idle). Persists only when textIndexPersist is enabled; a no-op otherwise. */
export async function flushIndex<T>(ctx: SearchContext<T>): Promise<void> {
  if (!ctx.searchIndexStore) return
  await ctx.ensureHydrated()
  const labelMaps = await resolveDictLabelMaps(ctx)
  const blobFilenames = await resolveBlobFilenames(ctx)
  await ctx.searchIndexStore.ensureBuilt(() => buildRetrievalDocs(ctx, labelMaps, blobFilenames), positionBuildOptions(ctx))
  await ctx.searchIndexStore.flush?.()
}

/** L2 — load + decrypt all _vec sidecars into StoredVector[] for the VectorSet. */
function buildVectorLoad<T>(ctx: SearchContext<T>): () => Promise<StoredVector[]> {
  return async () => {
    const ids = await ctx.adapter.list(ctx.vault, '_vec')
    const out: StoredVector[] = []
    for (const vecId of ids) {
      // #726: _vec is a vault-wide bucket namespaced by collection prefix —
      // skip rows belonging to other collections before touching this one's.
      if (!isVecIdFor(ctx.name, vecId)) continue
      const id = decodeVecId(ctx.name, vecId)!
      // #721 defense-in-depth: a _vec row carries no _tier of its own; the purge
      // on elevate is best-effort and cannot reach a legacy sidecar, so gate on
      // the owning record's live tier. Envelope peek, no decryption.
      if (await liveRecordIsElevated(ctx.adapter, ctx.vault, ctx.name, id)) continue
      const env = await ctx.adapter.get(ctx.vault, '_vec', vecId)
      if (!env) continue
      // #726 fails-safe: a row can pass isVecIdFor's prefix filter yet still
      // be undecryptable under THIS collection's DEK — a surviving legacy
      // bare-id row whose record id happens to start with `<thisCollection>/`,
      // or plain corruption. _vec sidecars are derived, re-derivable
      // artifacts (embedOnWrite regenerates them on the record's next put()),
      // so best-effort skip is correct: never let one poison row crash
      // similarTo()/retrieve() for the whole collection.
      let body: string | null
      try {
        body = await ctx.codec.decryptJsonString({ collection: '_vec', id: vecId }, env)
      } catch {
        continue
      }
      if (body === null) continue
      // #1360: a body carries EITHER `vec` (whole-record, the original shape,
      // still written whenever no `chunk` hook is declared) or `chunks`
      // (sub-document). Reading both shapes is what makes chunking adoptable
      // without a rewrite: existing `_vec` rows keep loading unchanged.
      const parsed = JSON.parse(body) as { vec?: number[]; chunks?: { id: string; start: number; end: number; vec: number[] }[]; model: string }
      if (parsed.chunks && parsed.chunks.length > 0) {
        const chunks: StoredChunk[] = parsed.chunks.map((c) => ({ id: c.id, start: c.start, end: c.end, vec: new Float32Array(c.vec) }))
        out.push({ id, model: parsed.model, chunks })
      } else if (parsed.vec) {
        out.push({ id, vec: new Float32Array(parsed.vec), model: parsed.model })
      }
    }
    return out
  }
}

/**
 * L1.5 — build the PersistedIndexCallbacks bridge: crypto lives here
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
      const body = await ctx.codec.decryptJsonString({ collection: FT, id: ctx.name }, env)
      if (body === null) return null
      try {
        const wrapped = JSON.parse(body) as { fp: { count: number; maxVersion: number }; idx: string }
        return { json: wrapped.idx, fingerprint: wrapped.fp }
      } catch {
        return null
      }
    },
    save: async (json, fp, isStale) => {
      const ctx = provideCtx()
      const body = JSON.stringify({ fp, idx: json })
      const env = await ctx.codec.encryptJsonString({ collection: FT, id: ctx.name }, body, fp.count)
      // #725 review: a purge (removePersisted) can land while the encrypt above was
      // in flight — check right before the write and skip it rather than resurrect a
      // purged/forgotten record's blob. PersistedIndexStore's own post-save epoch
      // check is the backstop for every other ordering (incl. a purge landing during
      // this very put).
      if (isStale()) return
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

/** L1 — pre-build the lexical index (e.g. on open) so the first retrieve() pays no build scan. */
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
  await ctx.searchIndexStore.ensureBuilt(() => buildRetrievalDocs(ctx, labelMaps, blobFilenames), positionBuildOptions(ctx))
}

/**
 * Sentinel `limit` pushed into the mode branches when a `within` is present, so
 * the branch's own truncation (`InvertedIndex.query`'s slice, `cosineTopK`'s
 * `k`, `fuseRetrieval`'s `limit`) becomes a no-op and the caller's real `limit`
 * can be applied AFTER narrowing. `slice(0, Infinity)` is the whole list.
 */
const NO_LIMIT = Number.POSITIVE_INFINITY

/**
 * Retrieval. mode: 'lexical' (default) | 'semantic' (L2) | 'hybrid' (L3).
 *
 * ## `within` — the typed half of retrieval (#1343)
 *
 * Money / number / date / boolean fields are NOT tokenised into the lexical
 * index and never will be: instead of a second (typed-token) index format, a
 * typed match is expressed as an ordinary `Query` and handed to `within`, so
 * the comparison runs in the query engine — over the sorted / compound range
 * indexes — in each field's CANONICAL space (money as its scaled integer, not
 * as a lexically-compared string). `retrieve()` contributes the text half and
 * intersects.
 *
 * Two ordering properties, both load-bearing:
 *
 * - **Scoring is global; narrowing is not.** BM25 runs over the WHOLE corpus
 *   (df / N / avgdl unchanged by `within`), so a document's score is the same
 *   whichever `within` it is paired with — a filter re-ranks nothing. Narrowing
 *   the postings instead would make IDF filter-dependent and scores
 *   incomparable between two calls. It also costs nothing to score first: the
 *   index already scores every doc and only slices at the end.
 * - **`limit` counts hits from the NARROWED set.** Truncating corpus-wide first
 *   and filtering after would under-return (`limit: 10` yielding 1), so the
 *   mode branches run unlimited and the caller's `limit` is applied last.
 *
 * An empty `within` result set yields NO hits — never all of them.
 *
 * A `within` with an empty text query is **typed-only retrieval**: the typed
 * predicate is the whole query, returned in the usual hit shape (score 0,
 * `field: '(within)'`, empty snippet) so a typed and a text search are read the
 * same way. An empty query with NO `within` still matches nothing.
 */
export async function retrieve<T>(ctx: SearchContext<T>, query: string, opts: RetrieveOptions<T> = {}): Promise<RetrieveHit<T>[]> {
  if (opts.within === undefined) {
    return opts.mode === 'semantic' ? retrieveSemantic(ctx, query, opts)
      : opts.mode === 'hybrid' ? retrieveHybrid(ctx, query, opts)
      : retrieveLexical(ctx, query, opts)
  }
  // Typed-only: no query terms to score, so the whole answer is the id set.
  // Checked before the mode branches so it needs neither a textIndexes config
  // nor an embeddings config — a collection of pure money/number fields is a
  // legitimate `retrieve({ within })` target.
  if (segmentTokenizer(query).length === 0) return retrieveWithinOnly(ctx, opts, opts.within)
  const unlimited: RetrieveOptions<T> = { ...opts, limit: NO_LIMIT }
  const hits =
    opts.mode === 'semantic' ? await retrieveSemantic(ctx, query, unlimited)
    : opts.mode === 'hybrid' ? await retrieveHybrid(ctx, query, unlimited)
    : await retrieveLexical(ctx, query, unlimited)
  return applyWithin(hits, opts.within, opts.limit)
}

/**
 * L3 — keep only hits whose id matches the structured query, truncate to the
 * caller's `limit` (the mode branches ran unlimited), re-rank 1-based.
 */
function applyWithin<T>(hits: RetrieveHit<T>[], within: Query<T>, limit: number | undefined): RetrieveHit<T>[] {
  const ids = new Set(within._idArray())
  const kept = hits.filter(h => ids.has(h.id))
  const limited = limit !== undefined ? kept.slice(0, limit) : kept
  return limited.map((h, i) => ({ ...h, rank: i + 1 }))
}

/**
 * #1343 — typed-only retrieval: `retrieve('', { within })`. The hits are the
 * `within` ids in query order, presented like any other hit so callers need no
 * second result shape. `score` is 0 and `field` is `'(within)'` because nothing
 * was scored — a structured predicate either matches or does not, and faking a
 * BM25 number would invite sorting by it.
 */
async function retrieveWithinOnly<T>(ctx: SearchContext<T>, opts: RetrieveOptions<T>, within: Query<T>): Promise<RetrieveHit<T>[]> {
  if (ctx.lazy) {
    throw new Error(`Collection "${ctx.name}": retrieve() requires eager mode (prefetch: true).`)
  }
  await ctx.ensureHydrated()
  const ids = within._idArray()
  const limited = opts.limit !== undefined ? ids.slice(0, opts.limit) : ids
  return limited.map((id, i) => {
    const base: RetrieveHit<T> = { id, score: 0, rank: i + 1, field: '(within)', snippet: '' }
    if (opts.includeRecord) {
      const e = ctx.cache.get(id)
      if (e) (base as { record?: T }).record = stripI18nFilled(e.record as Record<string, unknown>) as T
    }
    return base
  })
}

/** L1 — client-side lexical retrieval; ranked { id, score, field, snippet, locale? }. */
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
  const index = await ctx.searchIndexStore.ensureBuilt(() => buildRetrievalDocs(ctx, labelMaps, blobFilenames), positionBuildOptions(ctx))
  const hits = index.query(query, {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.match ? { match: opts.match } : {}),
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
    ...(opts.fields ? { fields: opts.fields } : {}),
    ...(opts.boost ? { boost: opts.boost } : {}),
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

/** L3 — hybrid: fuse lexical (L1) + semantic (L2) by RRF. Requires embeddings. */
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

/** L2 — semantic branch of retrieve(): encode query → similarTo(). */
async function retrieveSemantic<T>(ctx: SearchContext<T>, query: string, opts: RetrieveOptions<T>): Promise<RetrieveHit<T>[]> {
  if (!ctx.embeddings) throw new Error(`Collection "${ctx.name}": retrieve({mode:'semantic'}) requires an embeddings config.`)
  if (ctx.lazy) throw new Error(`Collection "${ctx.name}": retrieve() requires eager mode (prefetch: true).`)
  const qVec = await ctx.embeddings.encode(query)
  return similarTo(ctx, qVec, {
    ...(opts.limit !== undefined ? { k: opts.limit } : {}),
    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
    ...(opts.includeRecord ? { includeRecord: true } : {}),
    ...(opts.exact !== undefined ? { exact: opts.exact } : {}),
    ...(opts.nprobe !== undefined ? { nprobe: opts.nprobe } : {}),
  })
}

/** L2 — raw-vector kNN over the encrypted vector set (decrypted in the trusted tier).
 *  Snippet is '' for vector hits in v1 (semantic match isn't span-located). */
export async function similarTo<T>(ctx: SearchContext<T>, vector: Float32Array, opts: SimilarToOptions = {}): Promise<RetrieveHit<T>[]> {
  if (!ctx.embeddings || !ctx.vectorSet) throw new Error(`Collection "${ctx.name}": similarTo() requires an embeddings config.`)
  if (ctx.lazy) throw new Error(`Collection "${ctx.name}": similarTo() requires eager mode (prefetch: true).`)
  await ctx.ensureHydrated()
  await ctx.vectorSet.ensureLoaded(buildVectorLoad(ctx))
  // #1360 part 2: `topK` picks exact vs approximate from the collection's
  // `embeddings.index` opt-in, the live vector count and this call's `exact`.
  // With no opt-in it IS `cosineTopK` — same function, same numbers.
  const hits = await ctx.vectorSet.topK(vector, opts.k ?? 10, {
    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
    ...(opts.exact !== undefined ? { exact: opts.exact } : {}),
    ...(opts.nprobe !== undefined ? { nprobe: opts.nprobe } : {}),
    expectModel: ctx.embeddings.model,
  })
  return hits.map((h, i) => {
    const e = ctx.cache.get(h.id)
    // #1360: for a chunk hit the snippet IS the matched span — resolved by
    // re-deriving the record's joined source text and slicing it at the same
    // offsets the writer used, so the returned span and the returned snippet
    // cannot disagree. Unchunked hits keep snippet '' (a whole-record vector
    // match is not span-located).
    let snippet = ''
    if (h.chunk && e && ctx.embeddings) {
      snippet = embeddingSourceText(e.record as Record<string, unknown>, ctx.embeddings.source).slice(h.chunk.start, h.chunk.end)
    }
    const base: RetrieveHit<T> = { id: h.id, score: h.score, rank: i + 1, field: '(vector)', snippet, ...(h.chunk ? { chunk: h.chunk } : {}) }
    if (opts.includeRecord && e) (base as { record?: T }).record = stripI18nFilled(e.record as Record<string, unknown>) as T
    return base
  })
}

/**
 * L2 — the embedding write-hook: derive a record's embedding vector at
 * write and persist it as the encrypted `_vec` side-car. Routed through the
 * search strategy so it runs only when `withSearch()` is opted in — computing
 * vectors that no gated `similarTo` / semantic `retrieve` could query would be
 * dead weight, so the compute is paired with the search capability. The caller
 * (`Collection.put`) only invokes this when `embeddings` is declared.
 */
export async function embedOnWrite<T>(ctx: SearchContext<T>, id: string, record: T, version: number): Promise<void> {
  if (!ctx.embeddings) return
  const text = embeddingSourceText(record as Record<string, unknown>, ctx.embeddings.source)
  // #1360 — sub-document chunking. When a `chunk` hook is declared and yields
  // usable spans, the sidecar holds ONE VECTOR PER CHUNK and no whole-record
  // vector: the whole-record encode is the thing chunking exists to avoid (it
  // averages a long document's topics away, and can exceed the model's context
  // window — the very case that motivates chunking). No chunk hook, or no
  // usable span, and the body is byte-for-byte the pre-#1360 single-vector
  // shape. Both live in the SAME encrypted `_vec` sidecar: no new store
  // collection, no new plaintext surface.
  const chunks = await deriveChunkVectors(text, ctx.embeddings)
  let body: string
  let writtenVec: Float32Array | undefined
  if (chunks.length > 0) {
    for (const c of chunks) {
      if (c.vec.length !== ctx.embeddings.dim) throw new EmbeddingDimMismatchError('embeddings', ctx.embeddings.dim, c.vec.length)
    }
    body = JSON.stringify({
      chunks: chunks.map((c) => ({ id: c.id, start: c.start, end: c.end, vec: Array.from(c.vec) })),
      model: ctx.embeddings.model,
      dim: ctx.embeddings.dim,
    })
  } else {
    const vec = await ctx.embeddings.encode(text)
    if (vec.length !== ctx.embeddings.dim) throw new EmbeddingDimMismatchError('embeddings', ctx.embeddings.dim, vec.length)
    writtenVec = vec
    body = JSON.stringify({ vec: Array.from(vec), model: ctx.embeddings.model, dim: ctx.embeddings.dim })
  }
  const vecEnv = await ctx.codec.encryptJsonString({ collection: '_vec', id: encodeVecId(ctx.name, id) }, body, version)
  await ctx.adapter.put(ctx.vault, '_vec', encodeVecId(ctx.name, id), vecEnv)
  // #1360 part 2 — hand the just-computed vectors to the in-memory set rather
  // than dropping it. Equivalent to the old `markDirty()` by construction: the
  // sidecar we just wrote is exactly what a reload would decrypt back, so the
  // next query sees the same vectors either way. The difference is cost —
  // `markDirty()` re-reads and re-decrypts every sidecar in the collection on
  // the next query, and would additionally rebuild the approximate index from
  // scratch after every single `put()`.
  if (chunks.length > 0) {
    ctx.vectorSet?.upsert({ id, model: ctx.embeddings.model, chunks: chunks.map((c) => ({ id: c.id, start: c.start, end: c.end, vec: c.vec })) })
  } else {
    ctx.vectorSet?.upsert({ id, model: ctx.embeddings.model, vec: writtenVec! })
  }
}

/**
 * Force-re-derive every eligible tier-0 record's `_vec` sidecar once (#788).
 * Opt-in bulk repair for the #726 re-namespace: legacy bare-id rows are
 * unreachable to `buildVectorLoad` (it only recognises `<collection>/<id>`
 * keys) and otherwise self-heal only when a record is next `put()` — this
 * lets an adopter recover recall immediately instead of waiting on writes.
 *
 * **Skips elevated records** (`liveRecordIsElevated`) rather than refusing
 * the whole walk — the OPPOSITE of `_applyCutoverTransform`'s
 * `assertCutoverTierSafe` refuse-whole-batch precedent. An elevated record is
 * SUPPOSED to have no `_vec` (`syncTierSearch` purges it on elevate);
 * re-embedding one here would write searchable plaintext-derived data above
 * tier 0. Load-bearing: never write a `_vec` row for an elevated record.
 *
 * Tombstones, delete markers, and a raw `get` racing a delete between `list`
 * and `get` all decrypt to `null` (`decryptRecord` already folds
 * tombstone/delete-marker into that null) and are skipped the same way.
 * Unconditional re-derive, no already-migrated check — safe to re-run after
 * a partial failure (each id is independently idempotent).
 */
export async function rebuildEmbeddings<T>(ctx: SearchContext<T>): Promise<{ rebuilt: number; skipped: number }> {
  if (!ctx.embeddings) return { rebuilt: 0, skipped: 0 }
  const ids = await ctx.adapter.list(ctx.vault, ctx.name)
  let rebuilt = 0
  let skipped = 0
  for (const id of ids) {
    if (await liveRecordIsElevated(ctx.adapter, ctx.vault, ctx.name, id)) { skipped++; continue }
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    if (!env) { skipped++; continue }
    const decoded = await ctx.codec.decryptRecord({ collection: ctx.name, id }, env)
    if (decoded === null) { skipped++; continue }
    await embedOnWrite(ctx, id, decoded, env._v ?? 1)
    rebuilt++
  }
  return { rebuilt, skipped }
}

/**
 * Sync the collection's SEARCH artifacts after a tier move (#721). Both the
 * lexical `_ftindex` blob and the `_vec/<id>` embedding are encrypted under
 * the tier-0 DEK and hold the record's derived plaintext (full field text /
 * a text-invertible vector), so leaving them means elevation never hid what
 * the record was searchable by — the `forget()` precedent, unapplied to
 * elevate. `null` → the record left tier 0: purge its `_vec` sidecar (mirrors
 * `Collection._purgeVector`), and invalidate the `_ftindex` blob (mirrors
 * `Collection._purgeSearchIndex`: deletes the persisted blob when persisted,
 * else drops the in-memory index) so the next `retrieve()` rebuilds from the
 * elevated-free `ctx.cache`. A record → it is tier-0 again: re-embed it via
 * {@link embedOnWrite}, then invalidate `_ftindex` so the rebuild includes it
 * again. No-op fast when the collection has neither a lexical index nor a
 * vector set.
 */
export async function syncTierSearch<T>(
  ctx: SearchContext<T>,
  id: string,
  record: T | null,
  version?: number,
): Promise<void> {
  if (!ctx.searchIndexStore && !ctx.vectorSet) return
  if (record === null) {
    await ctx.adapter.delete(ctx.vault, '_vec', encodeVecId(ctx.name, id))
    ctx.vectorSet?.removeRecord(id)
  } else {
    await embedOnWrite(ctx, id, record, version ?? 1)
  }
  const store = ctx.searchIndexStore
  if (store && 'removePersisted' in store) await (store as { removePersisted(): Promise<void> }).removePersisted()
  else store?.markDirty()
}
