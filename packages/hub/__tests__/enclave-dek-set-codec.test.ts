/**
 * #1317 — DEK-set serialization is an enclave door, not a `subtle.exportKey`
 * call in `wrapped-deks.ts`.
 *
 * `subtle.exportKey('raw', dek)` / `importKey('raw', …, 'AES-GCM')` assumed
 * `EnclaveKey === CryptoKey` and raw-extractable AES keys — both things the
 * barrel's `EnclaveKey` doc says a fork may discard. That line, not anything
 * in Shamir, is where a null-encryption or post-quantum enclave broke.
 *
 * The encoding must stay byte-identical for the reference enclave: the
 * `{ coll: base64(rawDek) }` map is the plaintext body of a persisted
 * `WrappedDeksBlob`. Hub mints DEKs extractable, so this can compare bytes
 * directly rather than via an oracle.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  exportDekSet,
  importDekSet,
  generateDEK,
  bufferToBase64,
  type EnclaveKey,
} from '../src/kernel/enclave/index.js'

const subtle = globalThis.crypto.subtle

async function freshDekSet(): Promise<Map<string, EnclaveKey>> {
  return new Map([
    ['notes', await generateDEK()],
    ['contacts', await generateDEK()],
  ])
}

describe('exportDekSet / importDekSet — enclave-owned DEK-set codec', () => {
  it('exportDekSet encodes each DEK as base64 of its raw bytes, keyed by collection', async () => {
    const deks = await freshDekSet()
    const exported = await exportDekSet(deks)
    expect(Object.keys(exported).sort()).toEqual(['contacts', 'notes'])
    for (const [coll, dek] of deks) {
      const raw = new Uint8Array(await subtle.exportKey('raw', dek))
      expect(exported[coll]).toBe(bufferToBase64(raw))
    }
  })

  it('importDekSet(exportDekSet(deks)) yields keys holding the same material', async () => {
    const deks = await freshDekSet()
    const back = await importDekSet(await exportDekSet(deks))
    expect([...back.keys()].sort()).toEqual([...deks.keys()].sort())
    const iv = new Uint8Array(12).fill(9)
    const probe = new TextEncoder().encode('dek-set codec probe')
    for (const [coll, dek] of deks) {
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, dek, probe as BufferSource)
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, back.get(coll)!, ct)
      expect(new Uint8Array(pt)).toEqual(probe)
    }
  })

  it('importDekSet returns extractable AES-GCM keys (what wrapped-deks handed back before)', async () => {
    const back = await importDekSet(await exportDekSet(await freshDekSet()))
    for (const key of back.values()) {
      expect(key.extractable).toBe(true)
      expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
      expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt'])
    }
  })

  it('wrapped-deks.ts no longer calls subtle.exportKey / importKey', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/with-party/team/wrapped-deks.ts', import.meta.url)),
      'utf8',
    )
    expect(src).not.toMatch(/exportKey|importKey/)
    expect(src).toMatch(/exportDekSet\(/)
    expect(src).toMatch(/importDekSet\(/)
  })
})
