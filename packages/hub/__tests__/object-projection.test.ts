/**
 * #412 P1 — the ObjectProjection contract + memoryObjectProjection reference
 * impl. This is the shared seam for direct-serve blobs (#412) and the debug
 * raw-object path (#413): write raw bytes as one native object + get a URL.
 */
import { describe, it, expect } from 'vitest'
import { memoryObjectProjection } from '../src/blobs/object-projection.js'

describe('#412 — ObjectProjection (memory reference impl)', () => {
  it('round-trips raw bytes through put/get/head/delete', async () => {
    const obj = memoryObjectProjection()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    await obj.putObject('a/b.png', bytes, { contentType: 'image/png' })

    const got = await obj.getObject('a/b.png')
    expect(got).not.toBeNull()
    expect(Buffer.from(got!).equals(Buffer.from(bytes))).toBe(true)

    const meta = await obj.headObject('a/b.png')
    expect(meta).toEqual({ size: 5, contentType: 'image/png' })

    await obj.deleteObject('a/b.png')
    expect(await obj.getObject('a/b.png')).toBeNull()
    expect(await obj.headObject('a/b.png')).toBeNull()
  })

  it('delete is idempotent; missing reads return null', async () => {
    const obj = memoryObjectProjection()
    await obj.deleteObject('nope') // no throw
    expect(await obj.getObject('nope')).toBeNull()
  })

  it('preserves user metadata (the secondary store)', async () => {
    const obj = memoryObjectProjection()
    await obj.putObject('k', new Uint8Array([9]), { contentType: 'application/octet-stream', userMeta: { backlink: 'tok_123' } })
    expect((await obj.headObject('k'))?.userMeta).toEqual({ backlink: 'tok_123' })
  })

  it('objectUrl: presigned (private) carries an expiry; public is a stable URL', async () => {
    const obj = memoryObjectProjection({ baseUrl: 'https://cdn.example.com' })
    await obj.putObject('priv', new Uint8Array([1]), { contentType: 'text/plain' })
    await obj.putObject('pub', new Uint8Array([1]), { contentType: 'text/plain', public: true })

    const priv = await obj.objectUrl('priv', { expiresInSeconds: 60 })
    expect(priv).toContain('expires=60')

    const pub = await obj.objectUrl('pub')
    expect(pub).toBe('https://cdn.example.com/pub')
    expect(pub).not.toContain('expires')
  })

  it('putUrl returns a direct-upload URL carrying the content type', async () => {
    const obj = memoryObjectProjection()
    const url = await obj.putUrl('big.mp4', { contentType: 'video/mp4' })
    expect(url).toContain('upload=memory')
    expect(url).toContain(encodeURIComponent('video/mp4'))
  })
})
