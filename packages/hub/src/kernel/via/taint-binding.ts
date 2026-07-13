// kernel/via/taint-binding.ts — the kernel-resident `taint` ViaBinding
// (#638 Task 3, closes the reproduced #636 leak).
//
// Bridges `ViaGraph`'s assigned effective postures (Task 1/2) into the SAME
// phase-B enforcement surfaces (`ViaPipeline.postureFor` → query gate +
// `redactForExport`) and, for the subset the graph marks sealed, seals the
// field's VALUE at rest via `ctx.sealedSlots` — byte-for-byte the same
// capability `via/classified/binding.ts` uses, no new crypto path.
//
// This file owns two independent things:
//   1. `buildTaintOverlay` — a PURE transform from the graph's raw per-field
//      postures to the enforcement-facing map `ViaPipeline.build`'s `taint`
//      param consumes (dropping untainted entries, clamping a sealed
//      field's `queryable` to `'none'`).
//   2. `taintBinding` — the `ViaBinding` that actually performs the sealing,
//      keyed on the graph's `taintSealedFields` set (never a brand-specific
//      field list the way classified/money declare their own).
//
// Neither is registered via `installViaBinder`/`viaBinder('taint')` — unlike
// money/i18n/classified/blob, a `taint` binding is never user-declared; it is
// constructed directly by `via/graph-wiring.ts#applyTaintOverlay`, the one
// caller, right after the graph has this collection's edges.
import type { ViaBinding, ViaCryptoCtx, SealedSlotRef, ViaPosture } from './index.js'
import { SealedHandle } from '../types.js'
import { DEFAULT_POSTURE } from './graph.js'
import { EXPORT_REDACTION_MARKER } from './pipeline.js'

const EMPTY_STRING_SET: ReadonlySet<string> = new Set()

/** Whether `p` is exactly the plain, non-taint baseline. */
function isDefaultPosture(p: ViaPosture): boolean {
  return p.encryptedAtRest === DEFAULT_POSTURE.encryptedAtRest && p.queryable === DEFAULT_POSTURE.queryable &&
    p.exportable === DEFAULT_POSTURE.exportable && p.forgettable === DEFAULT_POSTURE.forgettable
}

/**
 * Narrow the graph's raw per-field effective postures (`ViaGraph.
 * taintedPostures`) down to the enforcement-facing overlay `ViaPipeline.
 * build`'s `taint.postures` carries:
 *  - entries whose effective posture equals `DEFAULT_POSTURE` are DROPPED —
 *    nothing to enforce, and (#553) keeping `postureFor` returning
 *    `undefined` for an all-plain-sourced computed field matters: it is what
 *    lets a collection with ONLY plain-sourced computed fields keep
 *    `this.via === undefined` (see `applyTaintOverlay`'s no-op-when-empty
 *    contract below).
 *  - a `sealed` entry's `queryable` is clamped to `'none'`, regardless of
 *    what the graph's fold inherited (e.g. classified's own `'det-exact'`):
 *    `'det-exact'` presumes a purpose-built blind index the SOURCE binding
 *    (classified) builds for its own declared fields — this generic
 *    taint-seal never builds an equivalent index for the DERIVED field, so a
 *    derived+sealed field is, in truth, unqueryable by any means. This
 *    matches the query DSL's existing PARITY behavior for classified's own
 *    `'det-exact'` fields (`.where()` silently matches nothing, never
 *    throws) — a derived field has no such fallback because its stored form
 *    is opaque ciphertext, not a plain (if index-less) value, so `'none'`
 *    (explicit refusal) is the honest posture, not `'det-exact'`.
 *
 * Returns `undefined` when nothing survives the filter (equivalent to "no
 * taint on this collection").
 */
export function buildTaintOverlay(
  rawPostures: ReadonlyMap<string, ViaPosture>,
  sealFields: ReadonlySet<string>,
): ReadonlyMap<string, ViaPosture> | undefined {
  let out: Map<string, ViaPosture> | undefined
  for (const [field, posture] of rawPostures) {
    if (isDefaultPosture(posture)) continue
    out ??= new Map()
    out.set(field, sealFields.has(field) ? { ...posture, queryable: 'none' } : posture)
  }
  return out
}

/**
 * Seal every named field present with a defined value into its own sealed
 * slot via `crypto.sealedSlots`, peeling it out of the record. Mirrors
 * `via/classified/binding.ts#encodeClassifiedAtRest` exactly (same
 * capability, different field list — duplicated rather than imported so
 * this file never reaches into `via/**`, matching `via/graph-wiring.ts`'s
 * own documented-duplication precedent for `CLASSIFIED_POSTURE`).
 */
async function encodeTaintAtRest(
  record: Record<string, unknown>,
  crypto: ViaCryptoCtx,
  fields: readonly string[],
): Promise<{ record: Record<string, unknown>; sealed?: Record<string, SealedSlotRef> }> {
  let open = record
  let sealed: Record<string, SealedSlotRef> | undefined
  for (const field of fields) {
    if (!(field in record)) continue
    const value = record[field]
    if (value === undefined) continue
    const ref = await crypto.sealedSlots.seal(field, value)
    if (open === record) open = { ...record }
    delete open[field]
    sealed ??= {}
    sealed[field] = ref
  }
  return sealed ? { record: open, sealed } : { record }
}

/**
 * Restore every named field's sealed slot back onto the record: an opaque
 * `SealedHandle` under `asHandles` (never materialises plaintext into the
 * cache — matches classified's own `decodeAtRest`), the plaintext value
 * otherwise. A field named in `fields` but absent from a PARTICULAR record's
 * `sealed` map (over-taint / phantom graph registration — see cm8) is simply
 * skipped: this loop only ever reads keys `sealed` actually carries.
 */
async function decodeTaintAtRest(
  record: Record<string, unknown>,
  sealed: Record<string, SealedSlotRef>,
  crypto: ViaCryptoCtx,
  opts: { asHandles: boolean },
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  let out = record
  for (const field of fields) {
    const ref = sealed[field]
    if (ref === undefined) continue
    if (out === record) out = { ...record }
    out[field] = opts.asHandles
      ? new SealedHandle(() => crypto.sealedSlots.unseal(field, ref))
      : await crypto.sealedSlots.unseal(field, ref)
  }
  return out
}

/**
 * #642 `sealAllFields` mode — seal EVERY own field carrying a defined value,
 * except reserved/internal keys (`_`-prefixed, e.g. `_derivedFrom` — the
 * derivation/MV output provenance tag, which must stay a plain metadata
 * object, never sealed). Mirrors {@link encodeTaintAtRest} but iterates
 * `Object.keys(record)` instead of a fixed field list — a `'*'`-defaulted
 * output collection's field names are runtime `derive()` products, unknown
 * at declare time.
 */
async function encodeTaintAtRestAll(
  record: Record<string, unknown>,
  crypto: ViaCryptoCtx,
): Promise<{ record: Record<string, unknown>; sealed?: Record<string, SealedSlotRef> }> {
  let open = record
  let sealed: Record<string, SealedSlotRef> | undefined
  for (const field of Object.keys(record)) {
    if (field.startsWith('_')) continue
    const value = record[field]
    if (value === undefined) continue
    const ref = await crypto.sealedSlots.seal(field, value)
    if (open === record) open = { ...record }
    delete open[field]
    sealed ??= {}
    sealed[field] = ref
  }
  return sealed ? { record: open, sealed } : { record }
}

/**
 * #642 `sealAllFields` mode — restore every key PRESENT IN THE RECORD'S OWN
 * `sealed` map (no fixed field list to consult — the field set is whatever
 * {@link encodeTaintAtRestAll} actually sealed for this particular record).
 */
async function decodeTaintAtRestAll(
  record: Record<string, unknown>,
  sealed: Record<string, SealedSlotRef>,
  crypto: ViaCryptoCtx,
  opts: { asHandles: boolean },
): Promise<Record<string, unknown>> {
  let out = record
  for (const [field, ref] of Object.entries(sealed)) {
    if (out === record) out = { ...record }
    out[field] = opts.asHandles
      ? new SealedHandle(() => crypto.sealedSlots.unseal(field, ref))
      : await crypto.sealedSlots.unseal(field, ref)
  }
  return out
}

/**
 * The `taint` binding: seals `sealFields` at rest via `ctx.sealedSlots`,
 * presenting them as sealed handles on read — exactly as classified does,
 * reusing the same phase-B capability. `covers` = membership in `sealFields`
 * OR `presentRedactFields` (the brief's contract) — used by
 * `hasAtRestHooks`/`eraseSealed`'s posture-driven bookkeeping, NEVER by
 * `postureFor` (the taint OVERLAY short-circuits `postureFor` before any
 * binding's `covers`/`.posture` is consulted — see `ViaPipeline.postureFor`).
 * `erase` is intentionally unimplemented: today's crypto-shred
 * (`Collection._writeTombstone`) overwrites the whole envelope — `_sealed`
 * included — regardless of via bindings, so a taint-sealed field is already
 * erased on `forget()` with no extra participation; per-field erasure
 * bookkeeping (residue/shredded counts) is Task 6's (#622 forget fanout)
 * concern if ever needed.
 *
 * `presentRedactFields` (#638 Task 7, default empty) — tainted VIRTUAL
 * computed fields (never sealed — nothing to encodeAtRest/decodeAtRest;
 * `via/graph-wiring.ts#applyTaintOverlay` computes this set as
 * `graph.virtualFields(name) ∩ { field : postures.get(field).exportable ===
 * false }`). This binding is appended AFTER whatever `compileViaBindings`
 * built (including the `computed` binding), so its `present` hook — when
 * `presentRedactFields` is non-empty — runs LAST and overwrites a virtual
 * field's freshly-computed value with `EXPORT_REDACTION_MARKER`,
 * unconditionally, closing the read-time leak the same way `SealedHandle`
 * closes it for a materialized-sealed field. `encodeAtRest`/`decodeAtRest`/
 * `present` are all conditionally OMITTED (not just no-op) when their
 * respective field set is empty — a collection with ONLY a tainted virtual
 * field (no materialized-sealed field) must NOT flip
 * `ViaPipeline.hasAtRestHooks`, which would wrongly route it onto the async
 * at-rest-hook codec path for nothing to seal.
 *
 * `sealAllFields` (#642, default `false`) — whole-record seal for a
 * `'*'`-defaulted derivation/MV/overlay OUTPUT collection: `covers` claims
 * every non-`_`-prefixed field, and `encodeAtRest`/`decodeAtRest` route
 * through {@link encodeTaintAtRestAll}/{@link decodeTaintAtRestAll} instead
 * of the fixed `sealFields` list (moot in this mode — sealing everything is
 * already a superset of any field-specific taint on the same collection).
 */
export function taintBinding(
  sealFields: ReadonlySet<string>,
  presentRedactFields: ReadonlySet<string> = EMPTY_STRING_SET,
  sealAllFields = false,
): ViaBinding {
  const fields = [...sealFields]
  const redactFields = [...presentRedactFields]
  return {
    brand: 'taint',
    posture: { encryptedAtRest: 'sealed', queryable: 'none', exportable: false, forgettable: true },
    covers: (field) => sealAllFields ? !field.startsWith('_') : (sealFields.has(field) || presentRedactFields.has(field)),
    ...((sealAllFields || fields.length > 0) ? {
      encodeAtRest: (record: Record<string, unknown>, crypto: ViaCryptoCtx) =>
        sealAllFields ? encodeTaintAtRestAll(record, crypto) : encodeTaintAtRest(record, crypto, fields),
      decodeAtRest: (record: Record<string, unknown>, sealed: Record<string, SealedSlotRef>, crypto: ViaCryptoCtx, opts: { asHandles: boolean }) =>
        sealAllFields ? decodeTaintAtRestAll(record, sealed, crypto, opts) : decodeTaintAtRest(record, sealed, crypto, opts, fields),
    } : {}),
    ...(redactFields.length > 0 ? {
      present: (record: Record<string, unknown>) => {
        let out = record
        for (const field of redactFields) {
          if (field in out) {
            if (out === record) out = { ...record }
            out[field] = EXPORT_REDACTION_MARKER
          }
        }
        return out
      },
    } : {}),
  }
}
