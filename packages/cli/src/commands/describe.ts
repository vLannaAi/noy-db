/**
 * `noydb describe <file.noydb>` — emit a human-readable YAML/JSON
 * description of a bundle's structure (collections, fields, indexes,
 * FKs, MVs, overlays, derivations) with optional counters.
 *
 * Loads the bundle into an in-memory store, unlocks it with the
 * supplied secret + user, calls `vault.dumpSchema()`, then emits.
 *
 * See `design-history/2026-05-22-schema-dump-design.md`.
 *
 * @module
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { stringify as yamlStringify } from 'yaml'
import type {
  EncryptedEnvelope,
  NoydbStore,
  VaultSnapshot,
  VaultSchemaSnapshot,
} from '@noy-db/hub'
import {
  createNoydb,
  readPod,
  ConflictError,
  loadPersistedSchema,
  SCHEMAS_COLLECTION,
} from '@noy-db/hub'

const VERSION = '0.1.0'

export type DescribeFormat = 'yaml' | 'json'
export type SchemasMode = 'none' | 'full' | 'sidecar'

export interface DescribeOptions {
  readonly bundlePath: string
  readonly user: string
  readonly secret: string
  readonly format: DescribeFormat
  readonly withStats: boolean
  readonly schemas: SchemasMode
  readonly outPath?: string
  readonly sampleSize: number
}

interface SnapshotWithProvenance extends VaultSchemaSnapshot {
  _provenance: {
    generatedBy: string
    source: string
    sourceSha256: string
    emittedAt: string
  }
}

/** In-memory adapter — used only for the temporary vault that hosts the loaded bundle. */
function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        if (cn.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      for (const [cn, recs] of Object.entries(snap)) {
        const coll = getColl(v, cn)
        for (const [id, env] of Object.entries(recs)) coll.set(id, env)
      }
    },
  }
}

interface BackupShape {
  _compartment?: string
}

/** Run the full describe pipeline and return the emitted string. */
export async function describeBundle(opts: DescribeOptions): Promise<string> {
  const bytes = await readFile(opts.bundlePath)
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')

  const { dumpJson } = await readPod(new Uint8Array(bytes))
  const backup = JSON.parse(dumpJson) as BackupShape
  const compartmentName = backup._compartment ?? 'vault'

  // Build a fresh in-memory Noydb to host the loaded bundle. The
  // `user` + `secret` must match a keyring in the bundle.
  const db = await createNoydb({
    store: memoryStore(),
    user: opts.user,
    secret: opts.secret,
  })
  const vault = await db.openVault(compartmentName)
  await vault.load(dumpJson)

  // Touch each collection so its config (refs, validator if registered
  // in-process) is in the cache. For a fresh bundle load, there's no
  // app code registering schemas, so collections without persisted
  // _schemas envelopes will show `source: 'unknown'`.
  const collectionNames = await vault.collections()
  for (const name of collectionNames) {
    if (!name.startsWith('_')) vault.collection(name)
  }

  const snapshot = await vault.dumpSchema({
    withStats: opts.withStats,
    sampleSize: opts.sampleSize,
  })

  // Optionally inline the persisted JSON Schemas under each collection.
  const enriched = opts.schemas === 'full'
    ? await enrichWithFullSchemas(snapshot, vault, collectionNames)
    : snapshot

  // Attach provenance at the top. Build the object in key-order
  // we want emitted: _noydb_snapshot first, _provenance second, then
  // every snapshot field (without _noydb_snapshot which we already set).
  const { _noydb_snapshot: _ignore, ...rest } = enriched
  void _ignore
  const withProvenance: SnapshotWithProvenance = {
    _noydb_snapshot: 1,
    _provenance: {
      generatedBy: `noydb describe v${VERSION}`,
      source: basename(opts.bundlePath),
      sourceSha256,
      emittedAt: enriched.emittedAt,
    },
    vault: rest.vault,
    emittedAt: rest.emittedAt,
    subsystems: rest.subsystems,
    collections: rest.collections,
    materializedViews: rest.materializedViews,
    overlayViews: rest.overlayViews,
    derivations: rest.derivations,
    ...(rest.internal !== undefined ? { internal: rest.internal } : {}),
  }

  // Sidecar emission — write each collection's JSON Schema to a
  // separate file next to the main output.
  if (opts.schemas === 'sidecar' && opts.outPath) {
    await writeSidecarSchemas(opts.outPath, vault, collectionNames)
  }

  const emitted = emit(withProvenance, opts.format)
  if (opts.outPath) {
    await mkdir(dirname(opts.outPath), { recursive: true })
    await writeFile(opts.outPath, emitted)
  }
  return emitted
}

async function enrichWithFullSchemas(
  snapshot: VaultSchemaSnapshot,
  vault: { _introspectState(): { adapter: NoydbStore; name: string; getDEK: (n: string) => Promise<CryptoKey> } },
  collectionNames: readonly string[],
): Promise<VaultSchemaSnapshot> {
  const state = vault._introspectState()
  const collections: Record<string, unknown> = {}
  for (const name of Object.keys(snapshot.collections)) {
    const base = snapshot.collections[name]
    if (!base) continue
    if (!collectionNames.includes(name)) {
      collections[name] = base
      continue
    }
    try {
      const dek = await state.getDEK(name)
      const persisted = await loadPersistedSchema(state.adapter, state.name, name, dek)
      if (persisted?.jsonSchema) {
        collections[name] = { ...base, jsonSchema: persisted.jsonSchema }
      } else {
        collections[name] = base
      }
    } catch {
      collections[name] = base
    }
  }
  return { ...snapshot, collections: collections as VaultSchemaSnapshot['collections'] }
}

async function writeSidecarSchemas(
  outPath: string,
  vault: { _introspectState(): { adapter: NoydbStore; name: string; getDEK: (n: string) => Promise<CryptoKey> } },
  collectionNames: readonly string[],
): Promise<void> {
  const state = vault._introspectState()
  const sidecarDir = `${outPath}.schemas`
  await mkdir(sidecarDir, { recursive: true })
  for (const name of collectionNames) {
    if (name.startsWith('_')) continue
    try {
      const dek = await state.getDEK(name)
      const persisted = await loadPersistedSchema(state.adapter, state.name, name, dek)
      if (persisted?.jsonSchema) {
        await writeFile(
          join(sidecarDir, `${name}.schema.json`),
          JSON.stringify(persisted.jsonSchema, null, 2),
        )
      }
    } catch {
      // Skip collections we can't decrypt.
    }
  }
}

function emit(snapshot: SnapshotWithProvenance, format: DescribeFormat): string {
  if (format === 'json') {
    return JSON.stringify(snapshot, null, 2) + '\n'
  }
  // YAML — strict scalars; no anchors / refs for predictable output.
  return yamlStringify(snapshot, {
    aliasDuplicateObjects: false,
    indent: 2,
    lineWidth: 0, // never wrap; preserves long strings
  })
}

// ─── CLI dispatch ────────────────────────────────────────────

interface ParsedArgs {
  bundlePath: string
  user?: string
  secret?: string
  format: DescribeFormat
  withStats: boolean
  schemas: SchemasMode
  outPath?: string
  sampleSize: number
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = {
    bundlePath: '',
    format: 'yaml',
    withStats: false,
    schemas: 'none',
    sampleSize: 50,
  }
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--format') {
      const v = argv[++i]
      if (v !== 'yaml' && v !== 'json') return { error: `--format must be yaml or json (got: ${v ?? '<none>'})` }
      out.format = v
    } else if (arg === '--with-stats') {
      out.withStats = true
    } else if (arg === '--schemas') {
      const v = argv[++i]
      if (v !== 'none' && v !== 'full' && v !== 'sidecar') {
        return { error: `--schemas must be none|full|sidecar (got: ${v ?? '<none>'})` }
      }
      out.schemas = v
    } else if (arg === '-o' || arg === '--out') {
      const v = argv[++i]
      if (v === undefined) return { error: '-o requires a value' }
      out.outPath = v
    } else if (arg === '--secret') {
      const v = argv[++i]
      if (v === undefined) return { error: '--secret requires a value' }
      out.secret = v
    } else if (arg === '--user') {
      const v = argv[++i]
      if (v === undefined) return { error: '--user requires a value' }
      out.user = v
    } else if (arg === '--sample') {
      const n = parseInt(argv[++i] ?? '', 10)
      if (Number.isNaN(n) || n < 0) return { error: `--sample must be a non-negative integer` }
      out.sampleSize = n
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' }
    } else if (arg?.startsWith('-')) {
      return { error: `unknown option: ${arg}` }
    } else if (!out.bundlePath) {
      out.bundlePath = arg ?? ''
    } else {
      return { error: `unexpected positional arg: ${arg}` }
    }
    i++
  }
  if (!out.bundlePath) return { error: 'missing bundle path' }
  return out
}

function usage(): string {
  return [
    'usage: noydb describe <bundle-path> [options]',
    '',
    '  --format <yaml|json>     output format (default: yaml)',
    '  --with-stats             include records / bytes / oldest / newest per collection',
    '  --schemas <mode>         JSON Schema body inclusion (default: none)',
    '                           - none:    summary only',
    '                           - full:    inline complete JSON Schema per collection',
    '                           - sidecar: write `<out>.schemas/<col>.schema.json` siblings',
    '  -o, --out <file>         write to file instead of stdout',
    '  --user <userId>          keyring user identifier (required)',
    '  --secret <p>         decryption secret (or via NOYDB_SECRET env)',
    '  --sample <n>             max records sampled when no persisted/live schema (default: 50)',
    '',
    'Exit codes: 0 ok, 1 internal error, 2 usage error, 3 auth failure',
  ].join('\n')
}

export async function runDescribe(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(usage() + '\n')
      return 0
    }
    process.stderr.write(`describe: ${parsed.error}\n\n${usage()}\n`)
    return 2
  }
  const secret = parsed.secret ?? process.env.NOYDB_SECRET
  if (!secret) {
    process.stderr.write('describe: secret required — pass --secret or set NOYDB_SECRET env\n')
    return 3
  }
  if (parsed.secret) {
    process.stderr.write(
      '[noy-db] warning: --secret appears in shell history; consider NOYDB_SECRET env instead\n',
    )
  }
  if (!parsed.user) {
    process.stderr.write('describe: --user <userId> is required to unlock the bundle\n')
    return 2
  }

  try {
    const out = await describeBundle({
      bundlePath: parsed.bundlePath,
      user: parsed.user,
      secret,
      format: parsed.format,
      withStats: parsed.withStats,
      schemas: parsed.schemas,
      ...(parsed.outPath !== undefined ? { outPath: parsed.outPath } : {}),
      sampleSize: parsed.sampleSize,
    })
    if (!parsed.outPath) process.stdout.write(out)
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/decrypt|tamper|wrong key|invalid/i.test(msg)) {
      process.stderr.write(`describe: decryption failed — check --user and --secret\n  ${msg}\n`)
      return 3
    }
    process.stderr.write(`describe: ${msg}\n`)
    return 1
  }
}

// Re-export for tests
export { loadPersistedSchema, SCHEMAS_COLLECTION }
