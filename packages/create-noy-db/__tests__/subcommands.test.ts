/**
 * Tests for the v0.5 CLI subcommands — #38.
 *
 * Each subcommand is a pure function that accepts injected
 * dependencies (passphrase reader, Noydb factory, adapter factory),
 * so these tests don't spawn a subprocess, don't need a real
 * terminal, and don't touch the filesystem (except for the backup
 * command, which writes to `os.tmpdir()` and cleans up).
 *
 * Coverage goals per command:
 *   rotate   — happy path, explicit collections list, auto-detect
 *              collections, passphrase prompt cancelled, wrong
 *              passphrase
 *   addUser  — owner happy path, operator with permissions,
 *              operator without permissions rejected, passphrase
 *              mismatch rejected, wrong caller passphrase
 *   backup   — happy path writes a verifiable backup, rejects
 *              unsupported URI schemes, creates parent directories,
 *              resolves `file://` prefix, resolves plain paths
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createNoydb as realCreateNoydb,
  type NoydbAdapter,
  type EncryptedEnvelope,
  type CompartmentSnapshot,
  ConflictError,
  InvalidKeyError,
} from '@noy-db/core'
import { rotate } from '../src/commands/rotate.js'
import { addUser } from '../src/commands/add-user.js'
import { backup, resolveBackupTarget } from '../src/commands/backup.js'
import type { ReadPassphrase } from '../src/commands/shared.js'

// ─── Shared in-memory adapter (same shape as other test files) ──────

function memory(): NoydbAdapter {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: CompartmentSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

/**
 * Build a ReadPassphrase stub that returns the next queued answer
 * each time it's called. Test authors pass the sequence of
 * passphrases they expect the subcommand to ask for, in order.
 *
 * If the subcommand prompts more times than the queue has entries,
 * the stub throws — this catches tests that accidentally regressed
 * the prompt count and would otherwise silently return `undefined`.
 */
function scripted(...answers: string[]): ReadPassphrase {
  const queue = [...answers]
  return async (label: string) => {
    const next = queue.shift()
    if (next === undefined) {
      throw new Error(
        `scripted(): ran out of passphrases at prompt "${label}" (consumed ${answers.length})`,
      )
    }
    return next
  }
}

/**
 * Build a shared in-memory adapter + a `buildAdapter` closure that
 * always returns THAT adapter. Tests use this so the subcommand's
 * createNoydb call and the test's setup code see the same storage.
 */
function sharedAdapter() {
  const adapter = memory()
  return {
    adapter,
    build: (_dir: string) => adapter,
  }
}

// ─── Test setup — pre-populate a compartment with data ─────────────

interface Fixture {
  adapter: NoydbAdapter
  buildAdapter: (dir: string) => NoydbAdapter
}

async function makeFixture(): Promise<Fixture> {
  const { adapter, build } = sharedAdapter()
  // Create the compartment with an owner, a couple of collections,
  // and a few records per collection. Every test starts from this
  // baseline.
  const db = await realCreateNoydb({
    adapter,
    user: 'owner-alice',
    secret: 'alice-pass-1234',
  })
  const co = await db.openCompartment('demo-co')
  const invoices = co.collection<{ id: string; amount: number }>('invoices')
  await invoices.put('inv-1', { id: 'inv-1', amount: 100 })
  await invoices.put('inv-2', { id: 'inv-2', amount: 200 })
  const clients = co.collection<{ id: string; name: string }>('clients')
  await clients.put('c-1', { id: 'c-1', name: 'Acme' })
  db.close()
  return { adapter, buildAdapter: build }
}

// ─── rotate ────────────────────────────────────────────────────────

describe('noy-db rotate — #38', () => {
  let fx: Fixture
  beforeEach(async () => { fx = await makeFixture() })

  it('rotates every collection when no list is supplied', async () => {
    const result = await rotate({
      dir: 'unused',
      compartment: 'demo-co',
      user: 'owner-alice',
      readPassphrase: scripted('alice-pass-1234'),
      buildAdapter: fx.buildAdapter,
    })
    // Data collections are rotated; internal collections (`_ledger`,
    // `_ledger_deltas`) are filtered out of compartment.collections()
    // by loadAll's prefix filter, so they don't appear here.
    expect(result.rotated.sort()).toEqual(['clients', 'invoices'])
  })

  it('rotates only the requested collections when an explicit list is given', async () => {
    const result = await rotate({
      dir: 'unused',
      compartment: 'demo-co',
      user: 'owner-alice',
      collections: ['invoices'],
      readPassphrase: scripted('alice-pass-1234'),
      buildAdapter: fx.buildAdapter,
    })
    expect(result.rotated).toEqual(['invoices'])
  })

  it('reads every rotated record successfully with the post-rotate keyring', async () => {
    // This is the load-bearing assertion: after rotation, the caller's
    // keyring has the NEW DEKs, so a subsequent get() must still work.
    await rotate({
      dir: 'unused',
      compartment: 'demo-co',
      user: 'owner-alice',
      readPassphrase: scripted('alice-pass-1234'),
      buildAdapter: fx.buildAdapter,
    })
    // Reconnect via a fresh Noydb against the same (rotated) adapter.
    const db = await realCreateNoydb({
      adapter: fx.adapter,
      user: 'owner-alice',
      secret: 'alice-pass-1234',
    })
    const co = await db.openCompartment('demo-co')
    const invoices = co.collection<{ id: string; amount: number }>('invoices')
    expect(await invoices.get('inv-1')).toEqual({ id: 'inv-1', amount: 100 })
    expect(await invoices.get('inv-2')).toEqual({ id: 'inv-2', amount: 200 })
    db.close()
  })

  it('throws on a wrong passphrase', async () => {
    await expect(
      rotate({
        dir: 'unused',
        compartment: 'demo-co',
        user: 'owner-alice',
        readPassphrase: scripted('wrong-pass'),
        buildAdapter: fx.buildAdapter,
      }),
    ).rejects.toThrow(InvalidKeyError)
  })
})

// ─── add user ──────────────────────────────────────────────────────

describe('noy-db add user — #38', () => {
  let fx: Fixture
  beforeEach(async () => { fx = await makeFixture() })

  it('grants operator access with explicit permissions', async () => {
    const result = await addUser({
      dir: 'unused',
      compartment: 'demo-co',
      callerUser: 'owner-alice',
      newUserId: 'accountant-ann',
      role: 'operator',
      permissions: { invoices: 'rw' },
      readPassphrase: scripted(
        'alice-pass-1234',    // caller
        'ann-pass-5678',       // new user
        'ann-pass-5678',       // confirm
      ),
      buildAdapter: fx.buildAdapter,
    })
    expect(result.userId).toBe('accountant-ann')
    expect(result.role).toBe('operator')
  })

  it('lets the newly granted operator unlock the compartment', async () => {
    await addUser({
      dir: 'unused',
      compartment: 'demo-co',
      callerUser: 'owner-alice',
      newUserId: 'ann',
      role: 'operator',
      permissions: { invoices: 'rw', clients: 'ro' },
      readPassphrase: scripted('alice-pass-1234', 'ann-pass', 'ann-pass'),
      buildAdapter: fx.buildAdapter,
    })
    // Try to open the compartment as Ann. If the grant succeeded,
    // this works with the new passphrase and NOT the old one.
    const annDb = await realCreateNoydb({
      adapter: fx.adapter,
      user: 'ann',
      secret: 'ann-pass',
    })
    const co = await annDb.openCompartment('demo-co')
    const invoices = co.collection<{ id: string; amount: number }>('invoices')
    expect(await invoices.get('inv-1')).toEqual({ id: 'inv-1', amount: 100 })
    annDb.close()
  })

  it('rejects operator without --collections', async () => {
    await expect(
      addUser({
        dir: 'unused',
        compartment: 'demo-co',
        callerUser: 'owner-alice',
        newUserId: 'ann',
        role: 'operator',
        readPassphrase: scripted('alice-pass-1234', 'ann', 'ann'),
        buildAdapter: fx.buildAdapter,
      }),
    ).rejects.toThrow(/requires explicit --collections/)
  })

  it('rejects on passphrase confirmation mismatch', async () => {
    await expect(
      addUser({
        dir: 'unused',
        compartment: 'demo-co',
        callerUser: 'owner-alice',
        newUserId: 'bob',
        role: 'admin',
        readPassphrase: scripted(
          'alice-pass-1234',
          'bob-pass-first',
          'bob-pass-DIFFERENT',
        ),
        buildAdapter: fx.buildAdapter,
      }),
    ).rejects.toThrow(/do not match/)
  })

  it('rejects on wrong caller passphrase', async () => {
    await expect(
      addUser({
        dir: 'unused',
        compartment: 'demo-co',
        callerUser: 'owner-alice',
        newUserId: 'bob',
        role: 'admin',
        readPassphrase: scripted(
          'WRONG-CALLER-PASS',
          'bob-pass',
          'bob-pass',
        ),
        buildAdapter: fx.buildAdapter,
      }),
    ).rejects.toThrow(InvalidKeyError)
  })
})

// ─── backup ────────────────────────────────────────────────────────

describe('noy-db backup — #38', () => {
  let fx: Fixture
  let tmp: string

  beforeEach(async () => {
    fx = await makeFixture()
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'noy-db-backup-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('writes a verifiable backup to the target path', async () => {
    const target = path.join(tmp, 'demo.json')
    const result = await backup({
      dir: 'unused',
      compartment: 'demo-co',
      user: 'owner-alice',
      target,
      readPassphrase: scripted('alice-pass-1234'),
      buildAdapter: fx.buildAdapter,
    })
    expect(result.path).toBe(target)
    expect(result.bytes).toBeGreaterThan(100)

    // The file should exist on disk and parse as a valid v0.4
    // verifiable backup (has ledgerHead).
    const raw = await fs.readFile(target, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed._noydb_backup).toBe(1)
    expect(parsed._compartment).toBe('demo-co')
    expect(parsed.ledgerHead).toBeDefined()
    expect(parsed.ledgerHead.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('creates parent directories on demand', async () => {
    const target = path.join(tmp, 'nested', '2026', '04', 'demo.json')
    await backup({
      dir: 'unused',
      compartment: 'demo-co',
      user: 'owner-alice',
      target,
      readPassphrase: scripted('alice-pass-1234'),
      buildAdapter: fx.buildAdapter,
    })
    // File exists — the parent directory chain was created.
    await expect(fs.access(target)).resolves.toBeUndefined()
  })

  it('accepts a file:// URI', async () => {
    const target = path.join(tmp, 'from-uri.json')
    await backup({
      dir: 'unused',
      compartment: 'demo-co',
      user: 'owner-alice',
      target: `file://${target}`,
      readPassphrase: scripted('alice-pass-1234'),
      buildAdapter: fx.buildAdapter,
    })
    await expect(fs.access(target)).resolves.toBeUndefined()
  })

  it('rejects s3:// URIs with a clear message', () => {
    expect(() => resolveBackupTarget('s3://bucket/key.json')).toThrow(
      /Unsupported.*s3:\/\//,
    )
  })

  it('rejects https:// URIs', () => {
    expect(() => resolveBackupTarget('https://example.com/backup.json')).toThrow(
      /Unsupported.*https:\/\//,
    )
  })

  it('rejects on wrong passphrase', async () => {
    const target = path.join(tmp, 'wont-exist.json')
    await expect(
      backup({
        dir: 'unused',
        compartment: 'demo-co',
        user: 'owner-alice',
        target,
        readPassphrase: scripted('WRONG'),
        buildAdapter: fx.buildAdapter,
      }),
    ).rejects.toThrow(InvalidKeyError)
    // Target file was NOT created — rejection happened before write.
    await expect(fs.access(target)).rejects.toThrow()
  })
})
