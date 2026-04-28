/**
 * Showcase 54 — Storage: SQLite (single-file local)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-sqlite` exposes a `NoydbStore` that talks to any SQLite
 * binding through a small duck-typed `SqliteDatabase` interface
 * (`prepare(sql)` + `run / get / all`). The package documentation
 * lists three known-good drivers: `better-sqlite3`, the built-in
 * `node:sqlite` (Node 22+), and `bun:sqlite`. This showcase uses
 * `node:sqlite` because it has zero runtime dependencies — when run
 * on Node 22+ the showcase exercises a real SQLite file end-to-end.
 *
 * Why it matters
 * ──────────────
 * SQLite is the canonical *single-file local* backend: ideal for
 * desktop apps, CLI tools, and embedded scenarios where a JSON file
 * (`to-file`) is too coarse and a server (`to-postgres`) is too
 * heavy. The store gets `casAtomic: true` from SQLite's
 * `BEGIN IMMEDIATE` semantics, matching the contract that a multi-
 * writer adapter must satisfy.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 02 (`to-file` — the simpler local-disk story).
 * - Node 22+ is required for `node:sqlite`. The showcase skips
 *   cleanly on older runtimes and prints a hint.
 *
 * What to read next
 * ─────────────────
 *   - docs/packages/stores.md (full storage destination catalog)
 *   - the package's own README for the `better-sqlite3` and
 *     `bun:sqlite` driver examples.
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-sqlite
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { sqlite, type SqliteDatabase, type SqliteStatement } from '@noy-db/to-sqlite'

interface Note { id: string; text: string }

// ── Driver detection ──────────────────────────────────────────────────
//
// We try every known SQLite binding in order; the first one available
// wins. The showcase skips cleanly only when none are present — at
// which point the test report tells the developer how to enable it.
//
//   1. `node:sqlite` — built into Node 22+, but only when the runtime
//      was compiled with `--with-intl=full-icu` (most distributions do;
//      some homebrew builds don't).
//   2. `better-sqlite3` — universal Node binding. Install with
//      `pnpm add -D better-sqlite3 @types/better-sqlite3` in the
//      `showcases` package to enable this branch.
//
// The duck-typed `SqliteDatabase` interface from the store package is
// a tiny shim — `prepare()` + `exec()` — so any driver fits.
type DriverHandle = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): void
  close(): void
}

type DriverFactory = (path: string) => DriverHandle

let driverFactory: DriverFactory | null = null
let driverName: string | null = null

try {
  const mod = (await import('node:sqlite')) as {
    DatabaseSync: new (path: string) => DriverHandle
  }
  driverFactory = (path) => new mod.DatabaseSync(path)
  driverName = 'node:sqlite'
} catch {
  // node:sqlite not in this build — try better-sqlite3.
}

if (!driverFactory) {
  try {
    const mod = (await import('better-sqlite3')) as {
      default: new (path: string) => DriverHandle
    }
    driverFactory = (path) => new mod.default(path)
    driverName = 'better-sqlite3'
  } catch {
    // No driver available.
  }
}

const SQLITE_AVAILABLE = driverFactory !== null

if (!SQLITE_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.info(
    '[to-sqlite] Skipping — no SQLite driver found. Either run on a Node ≥22 build that ships `node:sqlite`, or install `better-sqlite3` as a devDependency in showcases/.',
  )
}

// ── SqliteDatabase shim ───────────────────────────────────────────────
//
// Both candidate drivers expose `prepare(sql)` returning a statement
// with `run / get / all`, plus `exec(sql)` — exactly the store's
// duck-typed contract. The shim widens `all()` to `readonly unknown[]`
// to match `SqliteStatement` and otherwise just delegates.
function adapt(handle: DriverHandle): SqliteDatabase {
  return {
    prepare(sql: string): SqliteStatement {
      const s = handle.prepare(sql)
      return {
        run: (...params) => s.run(...params),
        get: (...params) => s.get(...params),
        all: (...params) => s.all(...params) as readonly unknown[],
      }
    },
    exec(sql: string): void {
      handle.exec(sql)
    },
  }
}

describe.skipIf(!SQLITE_AVAILABLE)(`Showcase 54 — Storage: SQLite (${driverName ?? 'no driver'}, single-file local)`, () => {
  let workdir: string
  let dbPath: string
  let dbHandle: DriverHandle | null = null

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'noydb-showcase-54-'))
    dbPath = join(workdir, 'demo.sqlite')
  })

  afterAll(() => {
    dbHandle?.close()
    if (existsSync(workdir)) {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('round-trips records through a real SQLite file', async () => {
    dbHandle = driverFactory!(dbPath)
    const store = sqlite({ db: adapt(dbHandle) })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-sqlite-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in sqlite' })
    await notes.put('b', { id: 'b', text: 'still in sqlite' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in sqlite' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])

    db.close()
    dbHandle.close()
    dbHandle = null
  })

  it('persists across process restart — same file, new handle', async () => {
    // Use a dedicated file so this test doesn't collide with the
    // previous test's keyring (each call to createNoydb generates fresh
    // wrap salts, so re-opening someone else's file with a new
    // passphrase fails with INVALID_KEY — by design).
    const persistPath = join(workdir, 'persist.sqlite')
    const passphrase = 'storage-sqlite-persist-2026'

    // First handle writes a record and closes.
    {
      const handle = driverFactory!(persistPath)
      const db = await createNoydb({
        store: sqlite({ db: adapt(handle) }),
        user: 'alice',
        secret: passphrase,
      })
      const vault = await db.openVault('demo')
      await vault.collection<Note>('notes').put('persist', { id: 'persist', text: 'survives' })
      db.close()
      handle.close()
    }

    // Second handle re-opens the same file and reads the record.
    {
      const handle = driverFactory!(persistPath)
      const db = await createNoydb({
        store: sqlite({ db: adapt(handle) }),
        user: 'alice',
        secret: passphrase,
      })
      const vault = await db.openVault('demo')
      const got = await vault.collection<Note>('notes').get('persist')
      expect(got).toEqual({ id: 'persist', text: 'survives' })
      db.close()
      handle.close()
    }
  })
})
