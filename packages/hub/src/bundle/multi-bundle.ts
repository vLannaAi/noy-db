/**
 * Multi-compartment `.noydb` bundle (`NDBM`). A thin outer container
 * that embeds N standard single-vault `.noydb` bundles plus an
 * unencrypted, owner-curated **manifest**. The v1 single-vault format
 * is untouched; each compartment is a complete v1 bundle, produced by
 * `writeNoydbBundle` and read by `readNoydbBundle`.
 *
 * Layout: magic 'NDBM'(4) · version(1) · reserved(1) · manifestLen(4 BE)
 *         · manifest JSON · concat(inner v1 bundles, in manifest order).
 *
 * @packageDocumentation
 */
import type { Vault } from '../vault.js'
import type { PublicEnvelope } from '../meta/public-envelope/types.js'
import { sha256Hex } from '../crypto.js'
import { generateULID } from './ulid.js'
import { readUint32BE, writeUint32BE, hasNoydbBundleMagic } from './format.js'
import {
  writeNoydbBundle,
  readNoydbBundleHeader,
  readNoydbBundlePublicEnvelope,
  type WriteNoydbBundleOptions,
} from './bundle.js'

/** Magic bytes 'NDBM' — NOYDB Multi-compartment bundle. */
export const NOYDB_MULTI_BUNDLE_MAGIC = new Uint8Array([0x4e, 0x44, 0x42, 0x4d])
/** Fixed prefix: magic(4) + version(1) + reserved(1) + manifestLen(4). */
export const NOYDB_MULTI_BUNDLE_PREFIX_BYTES = 10
/** Current multi-bundle layout version. */
export const NOYDB_MULTI_BUNDLE_VERSION = 1

/** One compartment's entry in the pre-decrypt manifest. */
export interface CompartmentManifest {
  /** The inner v1 bundle's stable ULID handle. */
  readonly handle: string
  /** Owner-curated classification (e.g. 'shard', 'pool'). Opt-in. */
  readonly roleTag?: string
  /** ISO export timestamp. Always set by the writer; absent for a v1 bundle read as a 1-entry manifest. */
  readonly exportedAt?: string
  /** Compartment (vault) name. Opt-in disclosure. */
  readonly name?: string
  /** Collection names + record counts. Opt-in disclosure. */
  readonly collections?: readonly { readonly name: string; readonly count: number }[]
  /** Inner bundle's owner-curated public envelope, surfaced. Opt-in. */
  readonly publicEnvelope?: PublicEnvelope
  /** Byte length of the inner v1 bundle (drives framing). */
  readonly innerBytes: number
  /** SHA-256 (lowercase hex) of the inner v1 bundle bytes — pre-decrypt integrity. */
  readonly innerSha256: string
}

/** The unencrypted manifest of a multi-compartment bundle. */
export interface MultiBundleManifest {
  readonly multiFormatVersion: number
  /** Opaque ULID for the outer container. */
  readonly handle: string
  readonly compartments: readonly CompartmentManifest[]
}

/** Assemble the `NDBM` container from a manifest + inner bundle bytes (in manifest order). */
export function encodeMultiBundle(
  manifest: MultiBundleManifest,
  inner: readonly Uint8Array[],
): Uint8Array {
  validateManifest(manifest)
  if (manifest.compartments.length !== inner.length) {
    throw new Error(`multi-bundle: manifest has ${manifest.compartments.length} compartments but ${inner.length} inner bundles were provided.`)
  }
  for (let i = 0; i < inner.length; i++) {
    if (manifest.compartments[i]!.innerBytes !== inner[i]!.length) {
      throw new Error(`multi-bundle: compartment ${i} declares innerBytes ${manifest.compartments[i]!.innerBytes} but ${inner[i]!.length} bytes were provided.`)
    }
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const bodyLen = inner.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(NOYDB_MULTI_BUNDLE_PREFIX_BYTES + manifestBytes.length + bodyLen)
  out.set(NOYDB_MULTI_BUNDLE_MAGIC, 0)
  out[4] = NOYDB_MULTI_BUNDLE_VERSION
  out[5] = 0
  writeUint32BE(out, 6, manifestBytes.length)
  out.set(manifestBytes, NOYDB_MULTI_BUNDLE_PREFIX_BYTES)
  let off = NOYDB_MULTI_BUNDLE_PREFIX_BYTES + manifestBytes.length
  for (const b of inner) { out.set(b, off); off += b.length }
  return out
}

function hasMultiMagic(bytes: Uint8Array): boolean {
  if (bytes.length < NOYDB_MULTI_BUNDLE_MAGIC.length) return false
  for (let i = 0; i < NOYDB_MULTI_BUNDLE_MAGIC.length; i++) if (bytes[i] !== NOYDB_MULTI_BUNDLE_MAGIC[i]) return false
  return true
}

function validateManifest(parsed: unknown): asserts parsed is MultiBundleManifest {
  if (parsed === null || typeof parsed !== 'object') throw new Error('multi-bundle manifest must be a JSON object.')
  const m = parsed as Record<string, unknown>
  if (m['multiFormatVersion'] !== NOYDB_MULTI_BUNDLE_VERSION) throw new Error(`multi-bundle manifest.multiFormatVersion must be ${NOYDB_MULTI_BUNDLE_VERSION}, got ${String(m['multiFormatVersion'])}.`)
  if (typeof m['handle'] !== 'string' || m['handle'].length === 0) throw new Error('multi-bundle manifest.handle must be a non-empty string.')
  if (!Array.isArray(m['compartments'])) throw new Error('multi-bundle manifest.compartments must be an array.')
  const seenHandles = new Set<string>()
  for (const c of m['compartments'] as unknown[]) {
    if (c === null || typeof c !== 'object') throw new Error('multi-bundle compartment must be an object.')
    const e = c as Record<string, unknown>
    if (typeof e['handle'] !== 'string' || e['handle'].length === 0) throw new Error('multi-bundle compartment.handle must be a non-empty string.')
    if (seenHandles.has(e['handle'])) {
      throw new Error(`multi-bundle manifest has a duplicate compartment handle "${e['handle']}".`)
    }
    seenHandles.add(e['handle'])
    if (typeof e['innerBytes'] !== 'number' || !Number.isInteger(e['innerBytes']) || e['innerBytes'] < 0) throw new Error('multi-bundle compartment.innerBytes must be a non-negative integer.')
    if (typeof e['innerSha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(e['innerSha256'])) throw new Error('multi-bundle compartment.innerSha256 must be 64-char lowercase hex.')
  }
}

/** Parse the `NDBM` container into its manifest + raw inner bundle byte slices. */
export function decodeMultiBundle(bytes: Uint8Array): { manifest: MultiBundleManifest; inner: Uint8Array[] } {
  if (!hasMultiMagic(bytes)) throw new Error('not a NOYDB multi-bundle: missing NDBM magic.')
  if (bytes.length < NOYDB_MULTI_BUNDLE_PREFIX_BYTES) throw new Error('multi-bundle truncated: shorter than the fixed prefix.')
  if (bytes[4] !== NOYDB_MULTI_BUNDLE_VERSION) throw new Error(`unsupported multi-bundle version ${String(bytes[4])}.`)
  const manifestLen = readUint32BE(bytes, 6)
  const manifestEnd = NOYDB_MULTI_BUNDLE_PREFIX_BYTES + manifestLen
  if (manifestEnd > bytes.length) throw new Error('multi-bundle truncated: manifest length overruns the buffer.')
  const manifestJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(NOYDB_MULTI_BUNDLE_PREFIX_BYTES, manifestEnd))
  let parsed: unknown
  try { parsed = JSON.parse(manifestJson) } catch (err) { throw new Error(`multi-bundle manifest is not valid JSON: ${(err as Error).message}`) }
  validateManifest(parsed)
  const inner: Uint8Array[] = []
  let off = manifestEnd
  for (const c of parsed.compartments) {
    const end = off + c.innerBytes
    if (end > bytes.length) throw new Error(`multi-bundle truncated: compartment "${c.handle}" innerBytes overruns the buffer.`)
    inner.push(bytes.subarray(off, end))
    off = end
  }
  if (off !== bytes.length) {
    throw new Error(`multi-bundle: ${bytes.length - off} trailing byte(s) after the last compartment — buffer may be corrupt.`)
  }
  return { manifest: parsed, inner }
}

/** Per-compartment input to {@link writeMultiVaultBundle}. */
export interface MultiVaultCompartmentInput {
  readonly vault: Vault
  /** Owner-curated classification surfaced in the manifest (e.g. 'shard', 'pool'). */
  readonly roleTag?: string
  /** ISO timestamp for the manifest; defaults to now. */
  readonly exportedAt?: string
  /** Opt-in pre-decrypt disclosure for this compartment. */
  readonly disclose?: {
    /** `true` → use `vault.name`; a string → that explicit name. */
    readonly name?: boolean | string
    /** `true` → include collection names + record counts. */
    readonly collections?: boolean
    /** `true` → surface the inner bundle's public envelope into the manifest. */
    readonly publicEnvelope?: boolean
  }
  /** Options forwarded to `writeNoydbBundle` for this compartment's inner bundle. */
  readonly bundleOptions?: WriteNoydbBundleOptions
}

/** Write N vaults into one `NDBM` multi-compartment bundle. */
export async function writeMultiVaultBundle(
  compartments: readonly MultiVaultCompartmentInput[],
  opts: { readonly handle?: string } = {},
): Promise<Uint8Array> {
  if (compartments.length === 0) throw new Error('writeMultiVaultBundle: at least one compartment is required.')
  const inner: Uint8Array[] = []
  const entries: CompartmentManifest[] = []
  for (const c of compartments) {
    const innerBytes = await writeNoydbBundle(c.vault, c.bundleOptions ?? {})
    const header = readNoydbBundleHeader(innerBytes)
    const entry: {
      -readonly [K in keyof CompartmentManifest]: CompartmentManifest[K]
    } = {
      handle: header.handle,
      exportedAt: c.exportedAt ?? new Date().toISOString(),
      innerBytes: innerBytes.length,
      innerSha256: await sha256Hex(innerBytes),
    }
    if (c.roleTag !== undefined) entry.roleTag = c.roleTag
    if (c.disclose?.name !== undefined && c.disclose.name !== false) {
      entry.name = c.disclose.name === true ? c.vault.name : c.disclose.name
    }
    if (c.disclose?.collections === true) {
      const names = await c.vault.collections()
      entry.collections = await Promise.all(
        names.map(async (n) => ({ name: n, count: await c.vault.collection(n).count() })),
      )
    }
    if (c.disclose?.publicEnvelope === true) {
      const env = readNoydbBundlePublicEnvelope(innerBytes)
      if (env !== undefined) entry.publicEnvelope = env
    }
    inner.push(innerBytes)
    entries.push(entry)
  }
  const manifest: MultiBundleManifest = {
    multiFormatVersion: NOYDB_MULTI_BUNDLE_VERSION,
    handle: opts.handle ?? generateULID(),
    compartments: entries,
  }
  return encodeMultiBundle(manifest, inner)
}

/**
 * Read the pre-decrypt manifest of a bundle WITHOUT decrypting any
 * compartment. Accepts a multi-compartment `NDBM` bundle (returns its
 * N entries) OR a single v1 `NDB1` bundle (returns a 1-entry manifest,
 * for uniform handling). Throws on anything else.
 */
export async function readNoydbBundleManifest(bytes: Uint8Array): Promise<CompartmentManifest[]> {
  if (hasMultiMagic(bytes)) return [...decodeMultiBundle(bytes).manifest.compartments]
  if (hasNoydbBundleMagic(bytes)) {
    const header = readNoydbBundleHeader(bytes)
    const env = readNoydbBundlePublicEnvelope(bytes)
    const entry: { -readonly [K in keyof CompartmentManifest]: CompartmentManifest[K] } = {
      handle: header.handle,
      innerBytes: bytes.length,
      innerSha256: await sha256Hex(bytes),
    }
    if (env !== undefined) entry.publicEnvelope = env
    return [entry]
  }
  throw new Error('readNoydbBundleManifest: not a NOYDB bundle (no NDB1 or NDBM magic).')
}

/**
 * Extract one compartment's inner v1 `.noydb` bundle bytes, ready to
 * pass to `readNoydbBundle`. `selector` is a compartment `handle` or a
 * zero-based index. For a single v1 bundle, the bundle itself is the
 * only compartment.
 *
 * Does NOT verify the manifest `innerSha256` — it returns the raw
 * slice. Integrity is enforced downstream: `readNoydbBundle` verifies
 * the inner bundle's own `bodySha256`. Callers wanting an early,
 * pre-decrypt check can hash the returned bytes against the
 * compartment's `innerSha256`.
 */
export function readMultiVaultBundleCompartment(bytes: Uint8Array, selector: string | number): Uint8Array {
  if (typeof selector === 'number' && !Number.isInteger(selector)) {
    throw new Error(`readMultiVaultBundleCompartment: numeric selector must be an integer, got ${selector}.`)
  }
  if (hasNoydbBundleMagic(bytes) && !hasMultiMagic(bytes)) {
    const header = readNoydbBundleHeader(bytes)
    if (selector === 0 || selector === header.handle) return bytes
    throw new Error(`readMultiVaultBundleCompartment: single v1 bundle has only compartment "${header.handle}".`)
  }
  const { manifest, inner } = decodeMultiBundle(bytes)
  const idx = typeof selector === 'number'
    ? selector
    : manifest.compartments.findIndex((c) => c.handle === selector)
  if (idx < 0 || idx >= inner.length) throw new Error(`readMultiVaultBundleCompartment: no compartment ${typeof selector === 'number' ? `at index ${selector}` : `"${selector}"`}.`)
  return inner[idx]!
}
