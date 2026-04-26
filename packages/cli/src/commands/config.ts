/**
 * `noydb config validate` and `noydb config scaffold`.
 *
 * **validate** — sanity-check a `NoydbOptions` value at runtime. The
 * input file is expected to default-export a `NoydbOptions` object
 * (or a factory returning one). We dynamically import it and check:
 *
 *   - `store` is present and exposes the 6-method `NoydbStore` shape.
 *   - Sync targets have role ∈ {sync-peer, backup, archive} and a store.
 *   - `archive` targets don't carry a pull policy (archive is push-only).
 *   - `syncPolicy` pairs with at least one sync target.
 *   - `blob` routes (if present) sit on a bundle-capable store.
 *
 * **scaffold** — emit a working skeleton for one of the topology
 * profiles from `docs/guides/topology-matrix.md`. Output goes to stdout
 * (pipe to a file yourself) and is a ready-to-edit `.ts` + `.env`
 * pair, concatenated so the consumer can split them.
 *
 * @module
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export interface ValidationIssue {
  severity: 'warn' | 'error'
  code: string
  path: string
  message: string
}

export interface ValidationReport {
  ok: boolean
  issues: ValidationIssue[]
}

/**
 * Validate a NoydbOptions-shaped object (not a file path — this is
 * the programmatic API). Conservative: if a check can't be made
 * confidently, it's skipped rather than warned, to avoid nagging.
 */
/** Coerces arbitrary values to a human-readable string without triggering
 *  `[object Object]` — used by the config validator to report bad field types. */
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) {
    return String(v)
  }
  try { return JSON.stringify(v) } catch { return '<unserializable>' }
}

export function validateOptions(opts: unknown): ValidationReport {
  const issues: ValidationIssue[] = []

  if (!isRecord(opts)) {
    issues.push({ severity: 'error', code: 'not-object', path: '<root>',
      message: 'NoydbOptions must be an object' })
    return { ok: false, issues }
  }

  // Required: store
  if (!opts.store) {
    issues.push({ severity: 'error', code: 'missing-store', path: 'store',
      message: '`store` is required' })
  } else if (!isStoreShape(opts.store)) {
    issues.push({ severity: 'error', code: 'bad-store-shape', path: 'store',
      message: '`store` does not expose the 6-method NoydbStore contract' })
  }

  // sync — accept single store, SyncTarget, or SyncTarget[]
  if (opts.sync !== undefined) {
    const targets = normalizeSync(opts.sync)
    targets.forEach((t, i) => validateTarget(t, `sync[${i}]`, issues))
  }

  // syncPolicy requires at least one sync target
  if (opts.syncPolicy !== undefined && opts.sync === undefined) {
    issues.push({ severity: 'warn', code: 'policy-without-sync', path: 'syncPolicy',
      message: '`syncPolicy` has no effect without a `sync` target' })
  }

  // user is recommended
  if (typeof opts.user !== 'string' || !opts.user) {
    issues.push({ severity: 'warn', code: 'missing-user', path: 'user',
      message: '`user` identifier is recommended — audit entries default to "anonymous" without it' })
  }

  // passphrase-or-encryption check
  if (opts.secret === undefined && opts.passphrase === undefined && opts.encrypt !== false) {
    issues.push({ severity: 'warn', code: 'no-secret', path: 'secret',
      message: '`secret` / `passphrase` missing and `encrypt` not explicitly false — vault open will fail' })
  }

  const hasError = issues.some((i) => i.severity === 'error')
  return { ok: !hasError, issues }
}

/** Dynamically import a JS/MJS/CJS config file and pull the NoydbOptions
 *  out of it. Accepts a default export that is either the options
 *  object or a zero-arg function (sync or async) returning the options.
 *
 *  **TypeScript note.** Node cannot `import()` a bare `.ts` file without
 *  a loader. If the adopter's config is TypeScript, they should either
 *  compile it first (`tsc foo.ts`) or run the CLI under a TS-capable
 *  runtime (e.g. `tsx $(which noydb) config validate foo.ts`). The
 *  function throws a human-readable error for `.ts` input rather than
 *  propagating Node's cryptic `Unknown file extension` message. */
export async function loadOptionsFromFile(filePath: string): Promise<unknown> {
  const abs = resolve(filePath)
  if (abs.endsWith('.ts') || abs.endsWith('.mts') || abs.endsWith('.cts')) {
    throw new Error(
      `TypeScript config files are not directly loadable — Node has no native .ts loader.\n` +
      `  Options:\n` +
      `    (a) compile first:  tsc ${filePath} && noydb config validate ${filePath.replace(/\.[mc]?ts$/, '.js')}\n` +
      `    (b) run via tsx:    npx tsx $(which noydb) config validate ${filePath}\n` +
      `    (c) rename to .mjs/.js if your config has no TS-only syntax`,
    )
  }
  const mod = await import(pathToFileURL(abs).href) as { default?: unknown }
  const value = mod.default ?? mod
  if (typeof value === 'function') {
    return await (value as () => Promise<unknown>)()
  }
  return value
}

export async function runConfigValidate(argv: readonly string[]): Promise<number> {
  const file = argv[0]
  if (!file) {
    process.stderr.write('usage: noydb config validate <file.ts|js>\n')
    return 2
  }
  let opts: unknown
  try {
    opts = await loadOptionsFromFile(file)
  } catch (err) {
    process.stderr.write(`failed to load ${file}: ${(err as Error).message}\n`)
    return 1
  }

  const report = validateOptions(opts)
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  return report.ok ? 0 : 1
}

// ── Scaffold ────────────────────────────────────────────────────────────

/** Profiles match `docs/guides/topology-matrix.md` § View 3. */
export type Profile = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J'

export interface ScaffoldResult {
  profile: Profile
  code: string
  env: string
  notes: string
}

export function scaffold(profile: Profile): ScaffoldResult {
  switch (profile) {
    case 'A': return {
      profile, notes: 'Local-only single-user. No cloud.',
      code: [
        `import { createNoydb } from '@noy-db/hub'`,
        `import { jsonFile } from '@noy-db/to-file'`,
        ``,
        `export default {`,
        `  store:  jsonFile({ dir: process.env.NOYDB_DATA_DIR ?? './data' }),`,
        `  user:   process.env.NOYDB_USER ?? 'owner',`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=owner\nNOYDB_SECRET=\nNOYDB_DATA_DIR=./data\n`,
    }
    case 'B': return {
      profile, notes: 'Offline-first + cloud mirror. Local authoritative, sync opportunistically.',
      code: [
        `import { createNoydb, INDEXED_STORE_POLICY } from '@noy-db/hub'`,
        `import { browserIdbStore } from '@noy-db/to-browser-idb'`,
        `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`,
        ``,
        `export default {`,
        `  store: browserIdbStore({ prefix: process.env.NOYDB_APP ?? 'myapp' }),`,
        `  sync: [{`,
        `    store: awsDynamoStore({`,
        `      table:  process.env.NOYDB_DYNAMO_TABLE!,`,
        `      region: process.env.AWS_REGION ?? 'us-east-1',`,
        `    }),`,
        `    role:  'sync-peer',`,
        `    label: 'dynamo-live',`,
        `  }],`,
        `  syncPolicy: INDEXED_STORE_POLICY,`,
        `  user:   process.env.NOYDB_USER ?? 'owner',`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=owner\nNOYDB_SECRET=\nNOYDB_APP=myapp\nNOYDB_DYNAMO_TABLE=myapp-live\nAWS_REGION=us-east-1\n`,
    }
    case 'C': return {
      profile, notes: 'Records + blobs split (routeStore). Dynamo for records, S3 for blobs.',
      code: [
        `import { createNoydb, routeStore } from '@noy-db/hub'`,
        `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`,
        `import { awsS3Store } from '@noy-db/to-aws-s3'`,
        ``,
        `export default {`,
        `  store: routeStore({`,
        `    default: awsDynamoStore({`,
        `      table:  process.env.NOYDB_DYNAMO_TABLE!,`,
        `      region: process.env.AWS_REGION ?? 'us-east-1',`,
        `    }),`,
        `    blobs:   awsS3Store({`,
        `      bucket: process.env.NOYDB_S3_BUCKET!,`,
        `      region: process.env.AWS_REGION ?? 'us-east-1',`,
        `    }),`,
        `  }),`,
        `  user:   process.env.NOYDB_USER ?? 'owner',`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=owner\nNOYDB_SECRET=\nNOYDB_DYNAMO_TABLE=myapp-records\nNOYDB_S3_BUCKET=myapp-blobs\nAWS_REGION=us-east-1\n`,
    }
    case 'G': return {
      profile, notes: 'Middleware-hardened production: retry + breaker + cache + metrics.',
      code: [
        `import { createNoydb, wrapStore, withRetry, withCircuitBreaker, withCache, withHealthCheck, withMetrics } from '@noy-db/hub'`,
        `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`,
        ``,
        `export default {`,
        `  store: wrapStore(`,
        `    awsDynamoStore({ table: process.env.NOYDB_DYNAMO_TABLE! }),`,
        `    withRetry({ maxRetries: 3 }),`,
        `    withCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 }),`,
        `    withCache({ ttlMs: 60_000 }),`,
        `    withHealthCheck(),`,
        `    withMetrics({ onOperation: op => console.log(op) }),`,
        `  ),`,
        `  user:   process.env.NOYDB_USER ?? 'owner',`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=owner\nNOYDB_SECRET=\nNOYDB_DYNAMO_TABLE=myapp-prod\n`,
    }
    case 'D': return {
      profile, notes: 'Hot + cold tiered. Records age out to archive after N days.',
      code: [
        `import { createNoydb, routeStore } from '@noy-db/hub'`,
        `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`,
        `import { awsS3Store } from '@noy-db/to-aws-s3'`,
        ``,
        `export default {`,
        `  store: routeStore({`,
        `    default: awsDynamoStore({ table: process.env.NOYDB_DYNAMO_TABLE! }),`,
        `    age: {`,
        `      cold:          awsS3Store({ bucket: process.env.NOYDB_S3_COLD! }),`,
        `      coldAfterDays: Number(process.env.NOYDB_COLD_AFTER_DAYS ?? '90'),`,
        `    },`,
        `  }),`,
        `  user:   process.env.NOYDB_USER ?? 'owner',`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=owner\nNOYDB_SECRET=\nNOYDB_DYNAMO_TABLE=myapp-hot\nNOYDB_S3_COLD=myapp-archive\nNOYDB_COLD_AFTER_DAYS=90\n`,
    }
    case 'E': return {
      profile, notes: 'Multi-peer team sync. Primary + peer + backup + archive.',
      code: [
        `import { createNoydb } from '@noy-db/hub'`,
        `import { browserIdbStore } from '@noy-db/to-browser-idb'`,
        `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`,
        `import { awsS3Store } from '@noy-db/to-aws-s3'`,
        ``,
        `export default {`,
        `  store: browserIdbStore({ prefix: process.env.NOYDB_APP ?? 'team' }),`,
        `  sync: [`,
        `    { store: awsDynamoStore({ table: process.env.NOYDB_DYNAMO_TABLE! }), role: 'sync-peer', label: 'team-hot' },`,
        `    { store: awsS3Store({ bucket: process.env.NOYDB_S3_BACKUP! }),       role: 'backup',    label: 'team-backup' },`,
        `    { store: awsS3Store({ bucket: process.env.NOYDB_S3_ARCHIVE! }),      role: 'archive',   label: 'team-archive' },`,
        `  ],`,
        `  user:   process.env.NOYDB_USER ?? 'member',`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=member\nNOYDB_SECRET=\nNOYDB_APP=team\nNOYDB_DYNAMO_TABLE=team-hot\nNOYDB_S3_BACKUP=team-backup\nNOYDB_S3_ARCHIVE=team-archive\n`,
    }
    case 'F': return {
      profile, notes: 'CRDT collaboration — Yjs-backed shared records over the encrypted envelope.',
      code: [
        `import { createNoydb } from '@noy-db/hub'`,
        `import { browserIdbStore } from '@noy-db/to-browser-idb'`,
        `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`,
        `// import { yjsCollection } from '@noy-db/in-yjs'   // use inside your app`,
        ``,
        `export default {`,
        `  store: browserIdbStore({ prefix: 'collab' }),`,
        `  sync: [{ store: awsDynamoStore({ table: process.env.NOYDB_DYNAMO_TABLE! }), role: 'sync-peer' }],`,
        `  user:   process.env.NOYDB_USER!,`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
        ``,
        `// After createNoydb(), replace normal collections with yjsCollection() for CRDT fields.`,
      ].join('\n'),
      env: `NOYDB_USER=\nNOYDB_SECRET=\nNOYDB_DYNAMO_TABLE=collab-live\n`,
    }
    case 'H': return {
      profile, notes: 'USB-portable — everything on a single file store, no cloud.',
      code: [
        `import { createNoydb } from '@noy-db/hub'`,
        `import { jsonFile } from '@noy-db/to-file'`,
        ``,
        `export default {`,
        `  store:  jsonFile({ dir: process.env.NOYDB_DATA_DIR ?? '/Volumes/MY_USB/data' }),`,
        `  user:   process.env.NOYDB_USER!,`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=\nNOYDB_SECRET=\nNOYDB_DATA_DIR=/Volumes/MY_USB/data\n`,
    }
    case 'I': return {
      profile, notes: 'Multi-tenant geographic sharding — per-vault primary per region.',
      code: [
        `import { createNoydb } from '@noy-db/hub'`,
        `import { awsDynamoStore } from '@noy-db/to-aws-dynamo'`,
        ``,
        `// Pick the nearest region at init time based on tenant config.`,
        `const region = process.env.NOYDB_REGION ?? 'ap-southeast-1'`,
        `const table  = \`myapp-\${region}\``,
        ``,
        `export default {`,
        `  store:  awsDynamoStore({ table, region }),`,
        `  user:   process.env.NOYDB_USER!,`,
        `  secret: process.env.NOYDB_SECRET,`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=\nNOYDB_SECRET=\nNOYDB_REGION=ap-southeast-1\n`,
    }
    case 'J': return {
      profile, notes: 'Authentication bridge (passphrase-less unlock via OIDC or WebAuthn).',
      code: [
        `import { createNoydb } from '@noy-db/hub'`,
        `import { browserIdbStore } from '@noy-db/to-browser-idb'`,
        `// import { unlockWebAuthn } from '@noy-db/on-webauthn'   // in the browser`,
        `// import { keyConnector } from '@noy-db/on-oidc'         // in a server app`,
        ``,
        `export default {`,
        `  store: browserIdbStore({ prefix: process.env.NOYDB_APP ?? 'app' }),`,
        `  user:  process.env.NOYDB_USER!,`,
        `  // secret supplied by the unlock method at openVault() time, not here.`,
        `}`,
      ].join('\n'),
      env: `NOYDB_USER=\nNOYDB_APP=app\n`,
    }
  }
}

export async function runConfigScaffold(argv: readonly string[]): Promise<number> {
  const profileArg = argv.find((a) => a.startsWith('--profile='))
  const profile = (profileArg?.split('=')[1] ?? 'A') as Profile
  if (!/^[A-J]$/.test(profile)) {
    process.stderr.write(`unknown profile: ${profile}. Valid: A-J (see docs/guides/topology-matrix.md)\n`)
    return 2
  }
  const out = scaffold(profile)
  process.stdout.write(`// ── noydb config (profile ${out.profile}) ───────────────────\n`)
  process.stdout.write(`// ${out.notes}\n\n`)
  process.stdout.write(out.code + '\n\n')
  if (out.env) {
    process.stdout.write(`// ── .env template ───────────────────────────────────────\n`)
    process.stdout.write(out.env)
  }
  return 0
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStoreShape(v: unknown): boolean {
  if (!isRecord(v)) return false
  return ['get', 'put', 'delete', 'list', 'loadAll', 'saveAll']
    .every((m) => typeof v[m] === 'function')
}

function normalizeSync(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  return [v]
}

function validateTarget(t: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(t)) {
    issues.push({ severity: 'error', code: 'bad-target', path,
      message: 'sync target must be an object with { store, role }' })
    return
  }
  if (t['role'] === undefined) {
    // Bare store is allowed — core wraps it as { store, role: 'sync-peer' }
    if (!isStoreShape(t)) {
      issues.push({ severity: 'error', code: 'bad-store-shape', path,
        message: 'sync target store does not expose the 6-method contract' })
    }
    return
  }
  const validRoles = ['sync-peer', 'backup', 'archive']
  if (!validRoles.includes(safeStringify(t['role']))) {
    issues.push({ severity: 'error', code: 'bad-role', path: `${path}.role`,
      message: `role must be one of ${validRoles.join(', ')}; got ${safeStringify(t['role'])}` })
  }
  if (!t['store'] || !isStoreShape(t['store'])) {
    issues.push({ severity: 'error', code: 'bad-store-shape', path: `${path}.store`,
      message: 'sync target store does not expose the 6-method contract' })
  }
  if (t['role'] === 'archive' && isRecord(t['policy']) && isRecord(t['policy']['pull'])) {
    issues.push({ severity: 'error', code: 'archive-pull-configured', path: `${path}.policy.pull`,
      message: 'archive targets are push-only — pull policy is invalid' })
  }
}
