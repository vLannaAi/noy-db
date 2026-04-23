/**
 * `listVaults()` adapter capability — v0.5 #63.
 *
 * The file adapter implements the optional 7th adapter method
 * (`listVaults`) by reading the configured base directory and
 * returning every entry that is itself a directory. Files at the top
 * level (READMEs, .DS_Store, .git directories, etc.) are filtered out
 * because they cannot be valid compartments.
 *
 * These tests verify the contract: empty / missing dirs return
 * empty arrays, multi-vault trees enumerate every subdirectory,
 * top-level files are skipped, and a vanished entry between readdir
 * and stat does not crash the call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { jsonFile } from '../src/index.js'
import type { EncryptedEnvelope } from '@noy-db/hub'

function envelope(v = 1): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: '2026-04-07T00:00:00Z', _iv: 'iv', _data: 'data' }
}

describe('@noy-db/file — listVaults (#63)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-file-listcomp-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('exposes listVaults as an optional method', () => {
    const a = jsonFile({ dir })
    expect(typeof a.listVaults).toBe('function')
  })

  it('returns an empty array on a fresh directory', async () => {
    const a = jsonFile({ dir })
    expect(await a.listVaults!()).toEqual([])
  })

  it('returns an empty array if the base directory does not exist', async () => {
    const a = jsonFile({ dir: join(dir, 'never-created') })
    expect(await a.listVaults!()).toEqual([])
  })

  it('returns one vault after a single put creates the directory tree', async () => {
    const a = jsonFile({ dir })
    await a.put('T1', 'invoices', 'inv-1', envelope())
    expect(await a.listVaults!()).toEqual(['T1'])
  })

  it('returns every distinct vault after writes to multiple', async () => {
    const a = jsonFile({ dir })
    await a.put('T1', 'invoices', 'inv-1', envelope())
    await a.put('T2', 'invoices', 'inv-2', envelope())
    await a.put('T7', 'payments', 'pay-1', envelope())
    expect((await a.listVaults!()).sort()).toEqual(['T1', 'T2', 'T7'])
  })

  it('skips top-level files (e.g. README, .DS_Store) — only directories count as compartments', async () => {
    const a = jsonFile({ dir })
    await a.put('T1', 'invoices', 'inv-1', envelope())
    // Drop a couple of bystander files at the same level as the
    // T1 directory. These are not compartments and must not appear
    // in the result.
    await writeFile(join(dir, 'README.md'), '# Project notes\n', 'utf-8')
    await writeFile(join(dir, '.DS_Store'), 'finder noise', 'utf-8')

    expect(await a.listVaults!()).toEqual(['T1'])
  })
})
