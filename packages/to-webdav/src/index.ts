/**
 * **@noy-db/to-webdav** — WebDAV-backed noy-db store.
 *
 * Per-record JSON objects over the WebDAV protocol (RFC 4918). Works
 * against Nextcloud, ownCloud, Apache `mod_dav`, nginx WebDAV, or any
 * compliant server. Pure `fetch()` — zero dependencies.
 *
 * Key path:
 *   `{baseUrl}/{prefix}/{vault}/{collection}/{id}.json`
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `false` — WebDAV has no atomic CAS; last-write-wins |
 * | `listPage`  | ✗ — `PROPFIND` Depth:1 returns the whole collection |
 * | `ping`      | ✓ — `PROPFIND Depth:0` on the root |
 *
 * For conflict-safe writes pair with `@noy-db/to-aws-dynamo` or
 * `@noy-db/to-postgres` as the primary and use WebDAV as a
 * `backup`/`archive` target in `routeStore`.
 *
 * ## Authentication
 *
 * WebDAV commonly uses Basic Auth. Pass an `Authorization` header via
 * `headers`, or override `fetch` with a wrapper that injects your
 * credentials (session token, app password, OAuth token).
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'

export interface WebDAVStoreOptions {
  /** Base URL of the WebDAV endpoint (with trailing slash optional). */
  readonly baseUrl: string
  /** Path prefix within the endpoint. Default `''`. */
  readonly prefix?: string
  /** Default headers sent with every request (e.g. Authorization). */
  readonly headers?: Record<string, string>
  /** Custom fetch — defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch
  /**
   * When `true` (default), PUT errors from missing parent collections
   * are recovered by MKCOL'ing the path and retrying once. Set to
   * `false` if the server already has the tree provisioned.
   */
  readonly autoMkcol?: boolean
  /**
   * When `true`, MKCOL the full path tree before EVERY put — not just
   * as a 404/409 fallback. Default `false`.
   *
   * Required for non-RFC-compliant servers (notably DriveHQ free tier
   * and some embedded NAS firmwares) that return `204 No Content` on a
   * PUT to a non-existent path AND silently flatten the file to the
   * server root instead of preserving the requested path. Without
   * eager MKCOL, the package's lazy fallback never fires (no 4xx to
   * trigger it) and writes silently land at the wrong location.
   *
   * Adds one extra round-trip per put; only enable when you've
   * confirmed your server has this quirk.
   */
  readonly eagerMkcol?: boolean
}

export function webdav(options: WebDAVStoreOptions): NoydbStore {
  const {
    baseUrl: rawBase,
    prefix = '',
    headers: baseHeaders = {},
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    autoMkcol = true,
    eagerMkcol = false,
  } = options

  const baseUrl = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase

  function urlFor(vault: string, collection: string, id: string): string {
    const segments = [prefix, vault, collection, `${id}.json`]
      .filter(Boolean)
      .map(encodeURIComponent)
    return `${baseUrl}/${segments.join('/')}`
  }

  function collectionUrl(vault: string, collection: string): string {
    const segments = [prefix, vault, collection].filter(Boolean).map(encodeURIComponent)
    return `${baseUrl}/${segments.join('/')}/`
  }

  async function mkcolRecursive(vault: string, collection?: string): Promise<void> {
    const parts = [prefix, vault, ...(collection ? [collection] : [])].filter(Boolean)
    let url = baseUrl
    for (const part of parts) {
      url += `/${encodeURIComponent(part)}`
      const res = await fetchImpl(url + '/', { method: 'MKCOL', headers: baseHeaders })
      // 201 Created, 405 Method Not Allowed (exists), and 409 Conflict are all
      // acceptable — we only fail on transport-level errors.
      if (res.status >= 500) {
        throw new Error(`WebDAV MKCOL failed at ${url}: ${res.status}`)
      }
    }
  }

  async function putOnce(vault: string, collection: string, id: string, body: string): Promise<Response> {
    return fetchImpl(urlFor(vault, collection, id), {
      method: 'PUT',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json',
      },
      body,
    })
  }

  // Very small PROPFIND XML body — we only need child hrefs.
  const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`

  async function listChildren(vault: string, collection: string): Promise<string[]> {
    const url = collectionUrl(vault, collection)
    const res = await fetchImpl(url, {
      method: 'PROPFIND',
      headers: {
        ...baseHeaders,
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: PROPFIND_BODY,
    })
    if (res.status === 404) return []
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV PROPFIND failed: ${res.status}`)
    }
    const xml = await res.text()
    // Extract <d:href>...</d:href> entries, drop the collection self-ref,
    // keep only .json leaves, and return the id portion.
    const hrefs = Array.from(xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g))
      .map(m => decodeURIComponent(m[1]!))
    const selfPath = new URL(url).pathname.replace(/\/+$/, '')
    const ids: string[] = []
    for (const href of hrefs) {
      const hrefPath = href.replace(/\/+$/, '')
      if (hrefPath === selfPath) continue
      const filename = hrefPath.split('/').pop()!
      if (!filename.endsWith('.json')) continue
      ids.push(filename.slice(0, -'.json'.length))
    }
    return ids.sort()
  }

  const store: NoydbStore = {
    name: 'webdav',

    async get(vault, collection, id) {
      const res = await fetchImpl(urlFor(vault, collection, id), {
        method: 'GET',
        headers: baseHeaders,
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`WebDAV GET failed: ${res.status}`)
      const text = await res.text()
      return JSON.parse(text) as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope) {
      // Note: casAtomic:false — expectedVersion is IGNORED. WebDAV
      // lacks server-side conditional metadata writes.
      const body = JSON.stringify(envelope)
      // Eager MKCOL: required for non-RFC servers (DriveHQ etc.) that
      // accept PUT-to-nonexistent with 204 and silently flatten.
      if (eagerMkcol) {
        await mkcolRecursive(vault, collection)
      }
      let res = await putOnce(vault, collection, id, body)
      if ((res.status === 404 || res.status === 409) && autoMkcol) {
        await mkcolRecursive(vault, collection)
        res = await putOnce(vault, collection, id, body)
      }
      if (!res.ok) throw new Error(`WebDAV PUT failed: ${res.status}`)
    },

    async delete(vault, collection, id) {
      const res = await fetchImpl(urlFor(vault, collection, id), {
        method: 'DELETE',
        headers: baseHeaders,
      })
      if (res.status !== 204 && res.status !== 404 && !res.ok) {
        throw new Error(`WebDAV DELETE failed: ${res.status}`)
      }
    },

    async list(vault, collection) {
      return listChildren(vault, collection)
    },

    async loadAll(vault) {
      const rootUrl = `${baseUrl}/${[prefix, vault].filter(Boolean).map(encodeURIComponent).join('/')}/`
      const res = await fetchImpl(rootUrl, {
        method: 'PROPFIND',
        headers: { ...baseHeaders, Depth: '1', 'Content-Type': 'application/xml' },
        body: PROPFIND_BODY,
      })
      if (res.status === 404) return {}
      if (!res.ok && res.status !== 207) {
        throw new Error(`WebDAV PROPFIND (loadAll) failed: ${res.status}`)
      }
      const xml = await res.text()
      const hrefs = Array.from(xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g))
        .map(m => decodeURIComponent(m[1]!))
      const selfPath = new URL(rootUrl).pathname.replace(/\/+$/, '')
      const collections = new Set<string>()
      for (const href of hrefs) {
        const hrefPath = href.replace(/\/+$/, '')
        if (hrefPath === selfPath) continue
        const segment = hrefPath.slice(selfPath.length + 1).split('/')[0]
        if (segment) collections.add(decodeURIComponent(segment))
      }
      const snap: VaultSnapshot = {}
      for (const collection of collections) {
        const ids = await listChildren(vault, collection)
        const bucket: Record<string, EncryptedEnvelope> = {}
        for (const id of ids) {
          const env = await store.get(vault, collection, id)
          if (env) bucket[id] = env
        }
        snap[collection] = bucket
      }
      return snap
    },

    async saveAll(vault, data) {
      for (const [collection, recs] of Object.entries(data)) {
        await mkcolRecursive(vault, collection)
        for (const [id, envelope] of Object.entries(recs)) {
          await store.put(vault, collection, id, envelope)
        }
      }
    },

    async ping() {
      try {
        const res = await fetchImpl(baseUrl + '/', {
          method: 'PROPFIND',
          headers: { ...baseHeaders, Depth: '0' },
        })
        return res.ok || res.status === 207
      } catch {
        return false
      }
    },
  }

  return store
}
