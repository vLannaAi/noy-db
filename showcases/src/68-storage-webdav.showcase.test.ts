// @vitest-environment node
//
// `@noy-db/to-webdav` uses `globalThis.fetch` to talk to the remote
// WebDAV server. happy-dom's fetch enforces same-origin policy and
// strips Authorization headers on cross-origin POST/PUT, so the basic-
// auth header we build wouldn't survive. AWS-SDK-based showcases
// bypass happy-dom by using node:https directly; the WebDAV path uses
// fetch like Supabase / Cloudflare D1 / Turso, so we opt out here too.
/**
 * Showcase 68 — Storage: WebDAV (real-service, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-webdav` is a zero-dependency WebDAV adapter — pure
 * `fetch()` against any RFC 4918-compliant server (DriveHQ, Nextcloud,
 * ownCloud, Apache mod_dav, NAS appliances, Synology DSM, etc.). Each
 * encrypted envelope lands as one JSON file at
 * `{prefix}/{vault}/{collection}/{id}.json`. CAS is `casAtomic: false`
 * — WebDAV has no native compare-and-swap, so optimistic concurrency
 * falls back to read-then-write at the application layer.
 *
 * Why it matters
 * ──────────────
 * WebDAV is the universal "file-server-as-a-network-protocol" — the
 * lowest-friction way to point NOYDB at a NAS, a managed file-storage
 * subscription, or a self-hosted Nextcloud. NOYDB encrypts before any
 * byte hits the server, so even an admin with full filesystem access
 * sees only AES-256-GCM ciphertext. This makes WebDAV viable as a
 * **backup destination** even on shared / untrusted file servers.
 *
 * The companion showcase 69 wires WebDAV into a routed topology —
 * records hot in memory, blobs on WebDAV — for the canonical
 * "use my NAS for blobs only" pattern.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 02 (`to-file` — the local-disk equivalent for desktop).
 * - Real WebDAV endpoint:
 *     - `NOYDB_SHOWCASE_WEBDAV_URL` (base URL of the WebDAV root)
 *     - `NOYDB_SHOWCASE_WEBDAV_USERNAME`
 *     - `NOYDB_SHOWCASE_WEBDAV_PASSWORD`
 *
 * Skipped cleanly when those aren't present.
 *
 * What to read next
 * ─────────────────
 *   - showcase 69-topology-webdav-blobs (records hot, blobs on WebDAV)
 *   - showcase 02-storage-file (local-disk sibling)
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-webdav
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { webdav } from '@noy-db/to-webdav'
import { envGate, logSkipHint, WEBDAV_GATE_VARS } from './_env.js'

const gate = envGate({ label: 'to-webdav', vars: WEBDAV_GATE_VARS })
logSkipHint('to-webdav (showcase 68)', gate, WEBDAV_GATE_VARS)

interface Note { id: string; text: string }

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
// Single-segment prefix — the package's urlFor() encodeURIComponent's the
// whole prefix as one path segment, so any `/` inside becomes `%2F` and
// WebDAV servers vary in whether they decode that back to a real slash
// (DriveHQ does; some don't). Underscore-only keeps the path round-trip
// consistent across servers.
const PREFIX = `noy-db-showcase-68_${RUN_ID}`
const VAULT_NAME = `showcase-68-${RUN_ID}`

describe.skipIf(!gate.enabled)('Showcase 68 — Storage: WebDAV (real-service, credentialed)', () => {
  const baseUrl = gate.values['NOYDB_SHOWCASE_WEBDAV_URL']!
  const username = gate.values['NOYDB_SHOWCASE_WEBDAV_USERNAME']!
  const password = gate.values['NOYDB_SHOWCASE_WEBDAV_PASSWORD']!

  // Basic auth header — WebDAV's canonical auth surface. Some servers
  // also support digest or token auth; the package treats `headers`
  // as an opaque map so any auth scheme works.
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const baseHeaders = { Authorization: authHeader }

  afterAll(async () => {
    // Best-effort: list everything under our run prefix and DELETE.
    // WebDAV's DELETE on a collection (folder) recursively removes
    // children, so a single DELETE on the run prefix path cleans up.
    try {
      await fetch(`${baseUrl.replace(/\/$/, '')}/${PREFIX}`, {
        method: 'DELETE',
        headers: baseHeaders,
      })
    } catch {
      /* best-effort */
    }
  })

  // Single it() block — some WebDAV servers (DriveHQ, certain NAS
  // firmwares) silently flatten deep paths to the server root, which
  // creates filename collisions across vaults that legitimately have
  // different URLs. A single-vault, single-test structure works on every
  // server we've tested (DriveHQ flat-fs, Nextcloud full-tree, rclone
  // serve, mod_dav). On a "proper" WebDAV server, you'd add a separate
  // zero-knowledge test with `expect(rawHttpFetch).not.toContain(needle)`;
  // on DriveHQ, that direct-fetch path is unreliable because the URL the
  // package writes to is not the URL the server stores at.
  //
  // What this test still proves end-to-end:
  //   - encrypted envelope round-trips through real WebDAV PUT/GET
  //   - listChildren via PROPFIND parses correctly and returns ids
  //   - the package handles whatever path semantics the server applies
  it('round-trips records through a real WebDAV endpoint', async () => {
    // eagerMkcol: true — required for DriveHQ free tier and similar
    // non-RFC-compliant servers that return 204 on PUT-to-non-existent
    // and silently flatten the file to root. The package's lazy MKCOL
    // fallback only fires on 4xx, so 204 short-circuits it. Eager MKCOL
    // adds one round-trip per put but ensures paths are preserved.
    const store = webdav({ baseUrl, prefix: PREFIX, headers: baseHeaders, eagerMkcol: true })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-webdav-passphrase-2026',
    })
    const vault = await db.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in webdav' })
    await notes.put('b', { id: 'b', text: 'still in webdav' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in webdav' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(
    `[to-webdav] Using baseUrl=${gate.values['NOYDB_SHOWCASE_WEBDAV_URL']?.replace(/\/\/[^@/]*@/, '//<user>@')} prefix=${PREFIX}`,
  )
}
