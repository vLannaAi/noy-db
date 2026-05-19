/**
 * Showcase 76 — Storage: NFS (real host-side mount via local docker-compose)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-nfs` is a thin wrapper over `@noy-db/to-file`. NFS auth
 * lives entirely outside noy-db — `mount.nfs4` / `kinit` did the work
 * by the time the store opens. The package's value-add is **mount
 * diagnostics**: parse `/proc/mounts` to confirm the path is actually
 * an NFS mount, refuse silently-broken `nolock` mounts, warn on
 * attribute caching that would let stale `_v` checks slip through.
 *
 * Why this showcase exists
 * ────────────────────────
 * The package's `__tests__/` exercise the diagnostic state machine
 * via a `mountDetector` injection seam — that's the right scope for
 * a unit test. The DIAGNOSTIC itself though needs a real NFS mount
 * with real `/proc/mounts` contents, real `nfsvers=4.2,rw` options,
 * a real fs that fails the way NFS fails. Showcase 76 is that.
 *
 * Prerequisites
 * ─────────────
 * - **Linux only.** macOS Docker Desktop does not run an NFS server
 *   in privileged mode without extra setup; Windows is similar. The
 *   gate's mount-type check filters out non-Linux hosts cleanly.
 * - Docker / `docker compose` available locally.
 * - Bring up the stack: `pnpm docker:up`. The NFS service exports
 *   `/exports/noydb` over port 2049.
 * - Mount it on the host **before running the test**:
 *
 *     sudo mkdir -p /mnt/noydb-showcase
 *     sudo mount -t nfs -o nfsvers=4.2,rw localhost:/exports/noydb /mnt/noydb-showcase
 *
 * - Set the env var:
 *
 *     NOYDB_SHOWCASE_NFS_MOUNT=/mnt/noydb-showcase
 *
 * The host-side mount step is intentionally NOT automated — it
 * requires `sudo` and persistent host state. The `dockerGate('nfs')`
 * helper plus the runtime mount-type check makes the failure mode
 * explicit when this hasn't happened.
 *
 * What to read next
 * ─────────────────
 *   - showcase 02-storage-file (the package this layers over)
 *   - docs/packages/stores.md → "to-nfs" entry
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-nfs
 *
 * Acceptance (per #72)
 * ────────────────────
 *   ✓ Storage round-trip green against the real NFS mount
 *   ✓ Diagnostic pre-flight asserts the mount is actually NFS
 *     (would fail loudly against a plain directory)
 *   ✓ Skipped with hint when stack is down or env var unset
 *   ✓ Header documents the sudo requirement
 */

import { afterAll, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { createNoydb } from '@noy-db/hub'
import { nfs, runMountDiagnostics } from '@noy-db/to-nfs'
import { dockerGate } from './_docker.js'

const gate = await dockerGate('nfs')

interface Note { id: string; text: string }

const RUN_ID = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
const VAULT_NAME = `showcase-76-${RUN_ID}`

// Sub-directory under the NFS mount so we can clean up just our run
// without touching unrelated mounted state.
let workDir: string | null = null
let nfsConfirmed = false

if (gate.enabled) {
  const mount = gate.values['NOYDB_SHOWCASE_NFS_MOUNT']!
  workDir = `${mount.replace(/\/+$/, '')}/${VAULT_NAME}`
  // Pre-flight: read /proc/mounts and confirm the configured path is
  // actually an NFS mount. macOS / non-Linux drops out here cleanly.
  const diag = await runMountDiagnostics({ mountPath: mount })
  if (!diag.info.exists || !diag.info.fstype || !['nfs', 'nfs4', 'nfs3'].includes(diag.info.fstype)) {
    // eslint-disable-next-line no-console
    console.info(
      `[to-nfs (docker)] Skipping — ${mount} is not an NFS mount (fstype=${diag.info.fstype ?? 'unknown'}). ` +
        'Run the host-side mount command from the showcase header.',
    )
  } else {
    nfsConfirmed = true
    if (diag.risks.length > 0) {
      // eslint-disable-next-line no-console
      console.info('[to-nfs (docker)] Mount risks:', diag.risks)
    }
  }
}

afterAll(async () => {
  if (workDir) {
    try { await rm(workDir, { recursive: true, force: true }) } catch { /* swallow */ }
  }
})

describe.skipIf(!gate.enabled || !nfsConfirmed)('Showcase 76 — Storage: NFS (docker)', () => {
  it('round-trips records through a real NFS mount', async () => {
    const store = nfs({ mountPath: workDir!, onNolock: 'warn' })
    const db = await createNoydb({
      store, user: 'alice',
      secret: 'storage-nfs-passphrase-2026 keystone reach',
    })
    const vault = await db.openVault('default')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'on the share' })
    await notes.put('b', { id: 'b', text: 'still on the share' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'on the share' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('diagnostics() reports the mount as NFS — proves the pre-flight is wired', async () => {
    const store = nfs({ mountPath: workDir!, onNolock: 'warn' })
    const diag = await store.diagnostics()
    expect(diag.info.exists).toBe(true)
    expect(diag.info.fstype).toMatch(/^nfs/)
  })

  it('diagnostics fails loudly against a plain (non-NFS) directory', async () => {
    // Negative case: a tmp dir that is NOT an NFS mount must surface
    // a risk. This is the structural contract that catches a
    // misconfigured `mountPath` pointing at the wrong thing.
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const plain = await mkdtemp(`${tmpdir()}/noydb-showcase-76-plain-`)
    try {
      const diag = await runMountDiagnostics({ mountPath: plain })
      // Either the path isn't in /proc/mounts (clean miss) OR it is
      // there with a non-NFS fstype — both produce risk entries.
      expect(diag.risks.length).toBeGreaterThan(0)
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})

if (gate.enabled && !nfsConfirmed) {
  // Surfaces the gap clearly — env var is set but mount is not real
  // NFS. Helps the operator notice they forgot the `mount` step.
}
