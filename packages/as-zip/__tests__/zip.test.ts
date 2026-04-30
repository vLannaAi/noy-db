/**
 * Tests for the zero-dep ZIP encoder.
 *
 * Covers:
 *   - writeZip produces a valid header (PK magic + EOCD signature)
 *   - File count round-trips through the central directory
 *   - Empty archive is still valid (just an EOCD)
 *   - CRC-32 matches reference values for known inputs
 *   - Filenames are UTF-8 encoded with the flag bit set
 *   - Round-trip via Node's `yauzl`-free manual parser — we read
 *     the archive back using DataView and verify every stored byte
 *     matches its input.
 */
import { describe, expect, it } from 'vitest'
import { writeZip, crc32, type ZipEntry } from '../src/zip.js'

describe('crc32', () => {
  it('matches published reference values', async () => {
    // Standard test vectors.
    expect(crc32(new Uint8Array([]))).toBe(0x00000000)
    expect(crc32(new TextEncoder().encode('a'))).toBe(0xe8b7be43)
    expect(crc32(new TextEncoder().encode('abc'))).toBe(0x352441c2)
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
  })
})

describe('writeZip', () => {
  it('produces a valid single-file archive', async () => {
    const entries: ZipEntry[] = [
      { path: 'hello.txt', bytes: new TextEncoder().encode('Hello, world!') },
    ]
    const bytes = await writeZip(entries)

    // PK signature at offset 0.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50)

    // EOCD signature at end — locate by scanning backward from end
    // (EOCD is fixed 22 bytes, no comment).
    const eocdOffset = bytes.length - 22
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50)
    // Records this disk + total = 1.
    expect(view.getUint16(eocdOffset + 8, true)).toBe(1)
    expect(view.getUint16(eocdOffset + 10, true)).toBe(1)
  })

  it('round-trips content — reads back LFH, filename, data', async () => {
    const payload = new TextEncoder().encode('hello,\n"world"')
    const entries: ZipEntry[] = [{ path: 'hello.csv', bytes: payload }]
    const bytes = await writeZip(entries)

    // Parse the local file header at offset 0.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(8, true)).toBe(0) // STORE
    const nameLen = view.getUint16(26, true)
    expect(nameLen).toBe('hello.csv'.length)
    const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLen))
    expect(name).toBe('hello.csv')

    // Read back the stored data.
    const dataStart = 30 + nameLen
    const dataEnd = dataStart + payload.length
    expect(bytes.subarray(dataStart, dataEnd)).toEqual(payload)
  })

  it('encodes multiple files with correct CD offsets', async () => {
    const entries: ZipEntry[] = [
      { path: 'a.txt', bytes: new Uint8Array([65]) },
      { path: 'b.txt', bytes: new Uint8Array([66]) },
      { path: 'c.txt', bytes: new Uint8Array([67]) },
    ]
    const bytes = await writeZip(entries)

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const eocdOffset = bytes.length - 22
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50)
    expect(view.getUint16(eocdOffset + 10, true)).toBe(3)

    const cdOffset = view.getUint32(eocdOffset + 16, true)
    // First CD header.
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50)
    const firstNameLen = view.getUint16(cdOffset + 28, true)
    const firstName = new TextDecoder().decode(
      bytes.subarray(cdOffset + 46, cdOffset + 46 + firstNameLen),
    )
    expect(firstName).toBe('a.txt')
  })

  it('uses UTF-8 filename flag (bit 11)', async () => {
    const entries: ZipEntry[] = [
      { path: 'ทเรศ.txt', bytes: new TextEncoder().encode('x') }, // Thai filename
    ]
    const bytes = await writeZip(entries)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const flags = view.getUint16(6, true)
    // Bit 11 (0x0800) must be set.
    expect(flags & 0x0800).toBe(0x0800)
  })

  it('empty archive is just an EOCD', async () => {
    const bytes = await writeZip([])
    expect(bytes.length).toBe(22)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(0x06054b50)
    expect(view.getUint16(8, true)).toBe(0)
  })

  it('stored size + CRC match the input bytes', async () => {
    const payload = new Uint8Array(2048)
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
    const entries: ZipEntry[] = [{ path: 'big.bin', bytes: payload }]
    const bytes = await writeZip(entries)

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const storedCrc = view.getUint32(14, true)
    const compressedSize = view.getUint32(18, true)
    const uncompressedSize = view.getUint32(22, true)
    expect(storedCrc).toBe(crc32(payload))
    expect(compressedSize).toBe(payload.length)
    expect(uncompressedSize).toBe(payload.length)
  })
})
