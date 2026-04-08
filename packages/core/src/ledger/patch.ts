/**
 * RFC 6902 JSON Patch — compute + apply.
 *
 * This module is the v0.4 "delta history" primitive: instead of
 * snapshotting the full record on every put (the v0.3 behavior),
 * `Collection.put` computes a JSON Patch from the previous version to
 * the new version and stores only the patch in the ledger. To
 * reconstruct version N, we walk from the genesis snapshot forward
 * applying patches. Storage scales with **edit size**, not record
 * size — a 10 KB record edited 1000 times costs ~10 KB of deltas
 * instead of ~10 MB of snapshots.
 *
 * ## Why hand-roll instead of using a library?
 *
 * RFC 6902 has good libraries (`fast-json-patch`, `rfc6902`) but every
 * single one of them adds a runtime dependency to `@noy-db/core`. The
 * "zero runtime dependencies" promise is one of the core's load-bearing
 * features, and the patch surface we actually need is small enough
 * (~150 LoC) that vendoring is the right call.
 *
 * What we implement:
 *   - `add`     — insert a value at a path
 *   - `remove`  — delete the value at a path
 *   - `replace` — overwrite the value at a path
 *
 * What we deliberately skip (out of scope for the v0.4 ledger use):
 *   - `move` and `copy` — optimizations; the diff algorithm doesn't
 *     emit them, so the apply path doesn't need them
 *   - `test` — used for transactional patches; we already have
 *     optimistic concurrency via `_v` at the envelope layer
 *   - Sophisticated array diffing (LCS, edit distance) — we treat
 *     arrays as atomic values and emit a single `replace` op when
 *     they differ. The accounting domain has small arrays where this
 *     is fine; if we ever need patch-level array diffing we can add
 *     it without changing the storage format.
 *
 * ## Path encoding (RFC 6902 §3)
 *
 * Paths look like `/foo/bar/0`. Each path segment is either an object
 * key or a numeric array index. Two characters need escaping inside
 * keys: `~` becomes `~0` and `/` becomes `~1`. We implement both.
 *
 * Empty path (`""`) refers to the root document. Only `replace` makes
 * sense at the root, and our diff function emits it as a top-level
 * `replace` when `prev` and `next` differ in shape (object vs array,
 * primitive vs object, etc.).
 */

/** A single JSON Patch operation. Subset of RFC 6902 — see file docstring. */
export type JsonPatchOp =
  | { readonly op: 'add'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'replace'; readonly path: string; readonly value: unknown }

/** A complete JSON Patch document — an array of operations. */
export type JsonPatch = readonly JsonPatchOp[]

// ─── Compute (diff) ──────────────────────────────────────────────────

/**
 * Compute a JSON Patch that, when applied to `prev`, produces `next`.
 *
 * The algorithm is a straightforward recursive object walk:
 *
 *   1. If both inputs are plain objects (and not arrays/null):
 *      - For each key in `prev`, recurse if `next` has it, else emit `remove`
 *      - For each key in `next` not in `prev`, emit `add`
 *   2. If both inputs are arrays AND structurally equal, no-op.
 *      Otherwise emit a single `replace` for the whole array.
 *   3. If both inputs are deeply equal primitives, no-op.
 *   4. Otherwise emit a `replace` at the current path.
 *
 * We do not minimize patches across move-like rearrangements — every
 * generated patch is straightforward enough to apply by hand if you
 * had to debug it.
 */
export function computePatch(prev: unknown, next: unknown): JsonPatch {
  const ops: JsonPatchOp[] = []
  diff(prev, next, '', ops)
  return ops
}

function diff(
  prev: unknown,
  next: unknown,
  path: string,
  out: JsonPatchOp[],
): void {
  // Both null / both undefined → no-op (we don't differentiate them
  // in JSON terms; canonicalJson would reject undefined anyway).
  if (prev === next) return

  // One side null, the other not → straight replace.
  if (prev === null || next === null) {
    out.push({ op: 'replace', path, value: next })
    return
  }

  const prevIsArray = Array.isArray(prev)
  const nextIsArray = Array.isArray(next)
  const prevIsObject = typeof prev === 'object' && !prevIsArray
  const nextIsObject = typeof next === 'object' && !nextIsArray

  // Type changed (e.g., object → primitive, array → object). Replace.
  if (prevIsArray !== nextIsArray || prevIsObject !== nextIsObject) {
    out.push({ op: 'replace', path, value: next })
    return
  }

  // Both arrays. We don't do clever LCS-based diffing — emit a single
  // replace for the whole array if they differ. See file docstring for
  // the rationale.
  if (prevIsArray && nextIsArray) {
    if (!arrayDeepEqual(prev as unknown[], next as unknown[])) {
      out.push({ op: 'replace', path, value: next })
    }
    return
  }

  // Both plain objects. Recurse key by key.
  if (prevIsObject && nextIsObject) {
    const prevObj = prev as Record<string, unknown>
    const nextObj = next as Record<string, unknown>
    const prevKeys = Object.keys(prevObj)
    const nextKeys = Object.keys(nextObj)

    // Handle removes and overlapping recursions in one pass over prev.
    for (const key of prevKeys) {
      const childPath = path + '/' + escapePathSegment(key)
      if (!(key in nextObj)) {
        out.push({ op: 'remove', path: childPath })
      } else {
        diff(prevObj[key], nextObj[key], childPath, out)
      }
    }
    // Handle adds.
    for (const key of nextKeys) {
      if (!(key in prevObj)) {
        out.push({
          op: 'add',
          path: path + '/' + escapePathSegment(key),
          value: nextObj[key],
        })
      }
    }
    return
  }

  // Two primitives that aren't strictly equal — replace.
  out.push({ op: 'replace', path, value: next })
}

function arrayDeepEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i])) return false
  }
  return true
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  const aArray = Array.isArray(a)
  const bArray = Array.isArray(b)
  if (aArray !== bArray) return false
  if (aArray && bArray) return arrayDeepEqual(a, b as unknown[])
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!(key in bObj)) return false
    if (!deepEqual(aObj[key], bObj[key])) return false
  }
  return true
}

// ─── Apply ──────────────────────────────────────────────────────────

/**
 * Apply a JSON Patch to a base document and return the result.
 *
 * The base document is **not mutated** — every op clones the parent
 * container before writing to it, so the caller's reference to `base`
 * stays untouched. This costs an extra allocation per op but makes
 * the apply pipeline reorderable and safe to interrupt.
 *
 * Throws on:
 *   - Removing a path that doesn't exist
 *   - Adding to a path whose parent doesn't exist
 *   - A path component that doesn't match the document shape (e.g.,
 *     trying to step into a primitive)
 *
 * Throwing is the right behavior for the ledger use case: a failed
 * apply means the chain is corrupted, which should be loud rather
 * than silently producing a wrong reconstruction.
 */
export function applyPatch<T = unknown>(base: T, patch: JsonPatch): T {
  let result: unknown = clone(base)
  for (const op of patch) {
    result = applyOp(result, op)
  }
  return result as T
}

function applyOp(doc: unknown, op: JsonPatchOp): unknown {
  // Empty path → operation targets the root. Only `replace` and `add`
  // make sense at the root, but we handle `remove` for completeness
  // (root removal returns null).
  if (op.path === '') {
    if (op.op === 'remove') return null
    return clone(op.value)
  }

  const segments = parsePath(op.path)
  return walkAndApply(doc, segments, op)
}

function walkAndApply(
  doc: unknown,
  segments: string[],
  op: JsonPatchOp,
): unknown {
  if (segments.length === 0) {
    // Should never happen — empty path is handled in applyOp().
    throw new Error('walkAndApply: empty segments (internal error)')
  }

  const [head, ...rest] = segments
  if (head === undefined) throw new Error('walkAndApply: undefined segment')

  if (rest.length === 0) {
    return applyAtTerminal(doc, head, op)
  }

  // Recurse into the child container, then rebuild the parent with
  // the modified child.
  if (Array.isArray(doc)) {
    const idx = parseArrayIndex(head, doc.length)
    const child = doc[idx]
    const newChild = walkAndApply(child, rest, op)
    const next = doc.slice()
    next[idx] = newChild
    return next
  }
  if (doc !== null && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>
    if (!(head in obj)) {
      throw new Error(`applyPatch: path segment "${head}" not found in object`)
    }
    const newChild = walkAndApply(obj[head], rest, op)
    return { ...obj, [head]: newChild }
  }
  throw new Error(
    `applyPatch: cannot step into ${typeof doc} at segment "${head}"`,
  )
}

function applyAtTerminal(
  doc: unknown,
  segment: string,
  op: JsonPatchOp,
): unknown {
  if (Array.isArray(doc)) {
    const idx =
      segment === '-' ? doc.length : parseArrayIndex(segment, doc.length + 1)
    const next = doc.slice()
    if (op.op === 'remove') {
      next.splice(idx, 1)
      return next
    }
    if (op.op === 'add') {
      next.splice(idx, 0, clone(op.value))
      return next
    }
    if (op.op === 'replace') {
      if (idx >= doc.length) {
        throw new Error(
          `applyPatch: replace at out-of-bounds array index ${idx}`,
        )
      }
      next[idx] = clone(op.value)
      return next
    }
  }
  if (doc !== null && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>
    if (op.op === 'remove') {
      if (!(segment in obj)) {
        throw new Error(
          `applyPatch: remove on missing key "${segment}"`,
        )
      }
      const next = { ...obj }
      delete next[segment]
      return next
    }
    if (op.op === 'add') {
      // RFC 6902: `add` on an existing key replaces it.
      return { ...obj, [segment]: clone(op.value) }
    }
    if (op.op === 'replace') {
      if (!(segment in obj)) {
        throw new Error(
          `applyPatch: replace on missing key "${segment}"`,
        )
      }
      return { ...obj, [segment]: clone(op.value) }
    }
  }
  throw new Error(
    `applyPatch: cannot apply ${op.op} at terminal segment "${segment}"`,
  )
}

// ─── Path encoding (RFC 6902 §3) ─────────────────────────────────────

/**
 * Escape a single path segment per RFC 6902 §3:
 *   `~` → `~0`
 *   `/` → `~1`
 *
 * Order matters: `~` must be escaped first, otherwise the `~1` we
 * just emitted would be re-escaped to `~01`.
 */
function escapePathSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

function unescapePathSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

function parsePath(path: string): string[] {
  if (!path.startsWith('/')) {
    throw new Error(`applyPatch: path must start with '/', got "${path}"`)
  }
  return path
    .slice(1)
    .split('/')
    .map(unescapePathSegment)
}

function parseArrayIndex(segment: string, max: number): number {
  if (!/^\d+$/.test(segment)) {
    throw new Error(
      `applyPatch: array index must be a non-negative integer, got "${segment}"`,
    )
  }
  const idx = Number.parseInt(segment, 10)
  if (idx < 0 || idx > max) {
    throw new Error(
      `applyPatch: array index ${idx} out of range [0, ${max}]`,
    )
  }
  return idx
}

// ─── Cheap structural clone ─────────────────────────────────────────

/**
 * Plain-JSON clone via JSON.parse(JSON.stringify(value)).
 *
 * Faster than `structuredClone` for our use because (a) we know our
 * inputs are JSON-compatible (no Dates, Maps, or BigInts — anything
 * else gets rejected by canonicalJson upstream), and (b) `structuredClone`
 * has overhead for handling arbitrary structured data we don't need.
 *
 * For tiny ledger entries (< 1 KB), the JSON round-trip is in the
 * single-digit microsecond range.
 */
function clone<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}
