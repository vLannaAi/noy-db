/**
 * Showcase 02 — Storage: JSON files on disk
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-file` lays records out as `{dir}/{vault}/{collection}/
 * {id}.json` on disk. The whole filesystem becomes inspectable —
 * which means an admin can `cat` a file and see exactly the
 * encrypted envelope the store wrote. Perfect for USB-stick workflows
 * and local development.
 *
 * Why it matters
 * ──────────────
 * Persistence is what separates a toy from a useful local-first
 * database. `to-file` is the simplest persistent backend the project
 * ships, and it's the canonical demo of "stores see only ciphertext"
 * — open the JSON file in your editor and verify with your own eyes.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 01 (in-memory equivalent).
 *
 * What to read next
 * ─────────────────
 *   - showcase 03-storage-browser-idb (the browser equivalent)
 *   - showcase 21-with-bundle (`.noydb` archive — durable on USB)
 *   - docs/recipes/personal-notebook.md (the canonical USB use case)
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNoydb } from '@noy-db/hub'
import { jsonFile } from '@noy-db/to-file'

interface Note { id: string; text: string }

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'noydb-showcase-02-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('Showcase 02 — Storage: JSON files on disk', () => {
  it('lays out files as {dir}/{vault}/{collection}/{id}.json', async () => {
    const db = await createNoydb({
      store: jsonFile({ dir: workDir }),
      user: 'alice',
      secret: 'storage-file-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'on disk' })
    db.close()

    // Verify the file landed at exactly the documented path.
    const files = await readdir(join(workDir, 'demo', 'notes'))
    expect(files).toEqual(['a.json'])
  })

  it('survives a process-restart — new Noydb sees the prior writes', async () => {
    const PASS = 'storage-file-passphrase-2026'
    const dir = workDir

    const db1 = await createNoydb({ store: jsonFile({ dir }), user: 'alice', secret: PASS })
    const v1 = await db1.openVault('demo')
    await v1.collection<Note>('notes').put('a', { id: 'a', text: 'persist me' })
    db1.close()

    // Simulate a restart: brand-new Noydb instance, brand-new
    // jsonFile() backed by the same directory.
    const db2 = await createNoydb({ store: jsonFile({ dir }), user: 'alice', secret: PASS })
    const v2 = await db2.openVault('demo')
    const out = await v2.collection<Note>('notes').get('a')
    expect(out).toEqual({ id: 'a', text: 'persist me' })
    db2.close()
  })

  it('the file contains ciphertext, not plaintext (cat-able verification)', async () => {
    const db = await createNoydb({
      store: jsonFile({ dir: workDir }),
      user: 'alice',
      secret: 'storage-file-passphrase-2026',
    })
    const vault = await db.openVault('demo')

    const SECRET = 'never-in-the-file-on-disk'
    await vault.collection<Note>('notes').put('a', { id: 'a', text: SECRET })
    db.close()

    const raw = await readFile(join(workDir, 'demo', 'notes', 'a.json'), 'utf8')
    expect(raw).not.toContain(SECRET)

    // The envelope shape is always present in plaintext (it has to be —
    // the store reads `_v` to do CAS without decrypting).
    const env = JSON.parse(raw) as { _noydb: number; _v: number; _iv: string; _data: string }
    expect(env._noydb).toBe(1)
    expect(typeof env._iv).toBe('string')
    expect(env._iv.length).toBeGreaterThan(0)
    expect(env._data.length).toBeGreaterThan(0)
  })
})
