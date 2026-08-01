/**
 * Filesystem simulation (#927).
 *
 * A REAL `Noydb` instance over the REAL `toFile` store and a REAL temp
 * directory — no in-memory stand-ins, no mocked hub internals. The
 * scenarios pin the three promises a file-backed vault actually makes:
 *
 *  1. durability — a full close/reopen cycle (new instance, same dir,
 *     same user+secret) reads back exactly what was written;
 *  2. zero-knowledge at rest — every byte the store put on disk is
 *     ciphertext: no plaintext field value appears in ANY file under
 *     the data directory (records, keyring, sync meta included);
 *  3. concurrent puts to distinct ids all land — `toFile` has
 *     `casAtomic: false`, but distinct-id writes never contend, so two
 *     instances hammering different ids must lose nothing.
 *
 * `node:fs` here is harness plumbing (temp dirs + raw byte inspection),
 * not hub code — the hub-portable rule applies to `packages/hub/src/**`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNoydb } from '../../../packages/hub/src/index.js'
import { toFile } from '../../../packages/to-file/src/index.js'
import type { Noydb } from '../../../packages/hub/src/index.js'

const SECRET = 'simulation-filesystem-secret-2026'
const VAULT = 'acme'

interface Invoice extends Record<string, unknown> { customer: string; amount: number }

async function openDb(dir: string, user = 'owner'): Promise<Noydb> {
  const db = await createNoydb({ store: toFile({ dir }), user, secret: SECRET })
  await db.openVault(VAULT)
  return db
}

/** Recursively collect every file path under `dir`. */
async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry)
    if ((await stat(path)).isDirectory()) out.push(...await allFiles(path))
    else out.push(path)
  }
  return out
}

describe('simulation: hub over toFile() on a real temp directory', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-sim-fs-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('data written by one instance survives a full close + reopen from the same directory', async () => {
    const first = await openDb(dir)
    const invoices = first.vault(VAULT).collection<Invoice>('invoices')
    await invoices.put('inv-001', { customer: 'alpha', amount: 5000 })
    await invoices.put('inv-002', { customer: 'beta', amount: 750 })
    first.close()

    // A brand-new instance — fresh cache, fresh keyring load from disk.
    const second = await openDb(dir)
    const reopened = second.vault(VAULT).collection<Invoice>('invoices')
    expect(await reopened.get('inv-001')).toEqual({ customer: 'alpha', amount: 5000 })
    expect(await reopened.get('inv-002')).toEqual({ customer: 'beta', amount: 750 })
    // list() returns the decrypted records themselves.
    const all = (await reopened.list()).sort((a, b) => a.customer.localeCompare(b.customer))
    expect(all).toEqual([
      { customer: 'alpha', amount: 5000 },
      { customer: 'beta', amount: 750 },
    ])
    second.close()
  })

  it('on-disk bytes are ciphertext — no plaintext field value appears in any file', async () => {
    const MARKER = 'TOPSECRET-PLAINTEXT-MARKER-8194'
    const db = await openDb(dir)
    await db.vault(VAULT).collection<Invoice>('invoices').put('inv-001', {
      customer: MARKER,
      amount: 314159,
    })
    db.close()

    // The record file is a JSON EncryptedEnvelope: a real IV, and a _data
    // payload that is base64 ciphertext, not parseable JSON.
    const envelopeRaw = await readFile(join(dir, VAULT, 'invoices', 'inv-001.json'), 'utf-8')
    const envelope = JSON.parse(envelopeRaw) as { _iv: string; _data: string }
    expect(envelope._iv.length).toBeGreaterThan(0)
    expect(() => JSON.parse(envelope._data)).toThrow()

    // Zero-knowledge at rest: sweep EVERY file the store created (records,
    // _keyring, _sync meta, ...) — the plaintext value must appear nowhere.
    const files = await allFiles(dir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = await readFile(file, 'utf-8')
      expect(content).not.toContain(MARKER)
      expect(content).not.toContain('314159')
    }
  })

  it('concurrent puts to distinct ids from two instances all land', async () => {
    const writerA = await openDb(dir)
    // Seed through A BEFORE opening B: an instance snapshots the vault
    // keyring at openVault(), so B must open after the collection DEK was
    // minted (keyring refresh across instances is the sync engine's job).
    await writerA.vault(VAULT).collection<Invoice>('invoices').put('seed', { customer: 'seed', amount: 0 })
    const writerB = await openDb(dir)

    const N = 10
    await Promise.all([
      ...Array.from({ length: N }, (_, i) =>
        writerA.vault(VAULT).collection<Invoice>('invoices').put(`a-${i}`, { customer: 'A', amount: i })),
      ...Array.from({ length: N }, (_, i) =>
        writerB.vault(VAULT).collection<Invoice>('invoices').put(`b-${i}`, { customer: 'B', amount: i })),
    ])
    writerA.close()
    writerB.close()

    // A fresh instance sees every write — nothing was lost or clobbered.
    const reader = await openDb(dir)
    const invoices = reader.vault(VAULT).collection<Invoice>('invoices')
    expect((await invoices.list()).length).toBe(2 * N + 1)
    for (let i = 0; i < N; i++) {
      expect(await invoices.get(`a-${i}`)).toEqual({ customer: 'A', amount: i })
      expect(await invoices.get(`b-${i}`)).toEqual({ customer: 'B', amount: i })
    }
    reader.close()
  })
})
