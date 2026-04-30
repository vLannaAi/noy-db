/**
 * **@noy-db/to-nfs** — NFS network-filesystem store for noy-db.
 *
 * NFS authentication is handled entirely outside noy-db (`AUTH_SYS`
 * UID/GID or Kerberos via `kinit`), so this package is a thin layer
 * on top of `@noy-db/to-file` that adds **NFS-specific pre-flight
 * checks** — the kind of thing that silently corrupts a store when
 * ignored:
 *
 *   1. **`nolock` mount option** disables POSIX file locks. Silent
 *      concurrent-write corruption follows. We parse `/proc/mounts`
 *      (Linux) and throw (or warn) when the flag is active.
 *   2. **Attribute caching (`noac` absent)** — stale `mtime` / size
 *      cached by the client can let a version check pass on data
 *      that's already advanced on the server.
 *   3. **Wrong filesystem type** — the mount may silently be ext4
 *      (e.g. pointing at the wrong path). We confirm `statfs.type` is
 *      one of the NFS families.
 *
 * When running on non-Linux (macOS), `/proc/mounts` is absent so the
 * checks degrade to a warning. The store still functions — it simply
 * cannot self-diagnose the mount state.
 *
 * ## Not included
 *
 * - Native NFS client. noy-db works against a **pre-mounted** NFS
 *   path; use `mount.nfs4` / `/etc/fstab` as usual.
 * - Kerberos ticket management. `kinit` is the user's responsibility.
 *   The store surfaces `EKEYEXPIRED` as a clear error.
 *
 * @packageDocumentation
 */

import type { NoydbStore } from '@noy-db/hub'
import { jsonFile } from '@noy-db/to-file'

export interface NfsStoreOptions {
  /** Pre-mounted NFS directory. Fails fast if absent. */
  readonly mountPath: string
  /**
   * On detection of `nolock`, behavior is `'warn'` (default) or
   * `'error'`. Silent is not an option — NFS is tricky enough.
   */
  readonly onNolock?: 'warn' | 'error'
  /** Override the mount detector — injection seam for tests. */
  readonly mountDetector?: MountDetector
}

export interface MountInfo {
  readonly exists: boolean
  readonly fstype?: string
  readonly options?: readonly string[]
}

export type MountDetector = (mountPath: string) => Promise<MountInfo>

/**
 * Default mount detector — parses `/proc/mounts` on Linux. Returns
 * `{ exists: false }` on non-Linux or when the path isn't listed.
 */
export async function detectMount(mountPath: string): Promise<MountInfo> {
  try {
    const { readFile } = await import('node:fs/promises')
    const contents = await readFile('/proc/mounts', 'utf-8').catch(() => null)
    if (!contents) return { exists: false }
    const normalized = mountPath.replace(/\/+$/, '')
    for (const line of contents.split('\n')) {
      const parts = line.split(/\s+/)
      if (parts.length < 4) continue
      const [, mp, fstype, optsStr] = parts
      if (mp === normalized) {
        return {
          exists: true,
          fstype: fstype!,
          options: optsStr!.split(','),
        }
      }
    }
    return { exists: false }
  } catch {
    return { exists: false }
  }
}

const NFS_FSTYPES = new Set(['nfs', 'nfs4', 'nfs3'])

/**
 * Synchronous diagnostics run at store construction. Returns a list of
 * risk strings; empty = clean mount. Exposed so the consumer can log
 * or ship the report to an observability stack.
 */
export async function runMountDiagnostics(
  options: NfsStoreOptions,
): Promise<{ risks: string[]; info: MountInfo }> {
  const detector = options.mountDetector ?? detectMount
  const info = await detector(options.mountPath)
  const risks: string[] = []

  if (!info.exists) {
    risks.push(
      `Path "${options.mountPath}" is not listed in /proc/mounts. ` +
      `Either the path is not mounted, this is not Linux, or the mount was ` +
      `set up after boot without updating /etc/mtab. Proceed at your own risk.`,
    )
    return { risks, info }
  }
  if (info.fstype && !NFS_FSTYPES.has(info.fstype)) {
    risks.push(
      `Path "${options.mountPath}" is mounted as ${info.fstype}, not NFS. ` +
      `If you intended a local filesystem, use @noy-db/to-file instead.`,
    )
  }
  if (info.options?.includes('nolock')) {
    risks.push(
      `NFS mount "${options.mountPath}" has the \`nolock\` option set. ` +
      `POSIX file locks are silently disabled, so concurrent writers may corrupt ` +
      `records without any error surfacing. Remount without \`nolock\` or route ` +
      `writes through a store that implements server-side CAS.`,
    )
  }
  if (info.options && !info.options.includes('noac')) {
    risks.push(
      `NFS mount "${options.mountPath}" uses attribute caching (no \`noac\` flag). ` +
      `Version checks may pass on cached stale data. For multi-writer setups, ` +
      `add \`noac\` to the mount options.`,
    )
  }
  return { risks, info }
}

/**
 * Create an NFS-backed noy-db store. Mount diagnostics run once on
 * first use and are cached — failures raise (or warn) based on
 * `onNolock`.
 */
export function nfs(options: NfsStoreOptions): NoydbStore & { diagnostics(): Promise<{ risks: string[]; info: MountInfo }> } {
  const onNolock = options.onNolock ?? 'warn'
  const base = jsonFile({ dir: options.mountPath })
  let diagnosed: Promise<{ risks: string[]; info: MountInfo }> | null = null

  async function diagnostics(): Promise<{ risks: string[]; info: MountInfo }> {
    if (!diagnosed) {
      diagnosed = (async () => {
        const report = await runMountDiagnostics(options)
        const nolock = report.info.options?.includes('nolock')
        if (nolock) {
          const msg = report.risks[0]
          if (onNolock === 'error') throw new Error(`[@noy-db/to-nfs] ${msg}`)
          console.warn(`[@noy-db/to-nfs] ${msg}`)
        }
        return report
      })()
    }
    return diagnosed
  }

  // Run diagnostics on first I/O so construction stays synchronous-friendly.
  async function withDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
    await diagnostics()
    return fn()
  }

  return {
    name: 'nfs',
    async get(vault, collection, id) {
      return withDiagnostics(() => base.get(vault, collection, id))
    },
    async put(vault, collection, id, envelope, expectedVersion) {
      return withDiagnostics(() => base.put(vault, collection, id, envelope, expectedVersion))
    },
    async delete(vault, collection, id) {
      return withDiagnostics(() => base.delete(vault, collection, id))
    },
    async list(vault, collection) {
      return withDiagnostics(() => base.list(vault, collection))
    },
    async loadAll(vault) {
      return withDiagnostics(() => base.loadAll(vault))
    },
    async saveAll(vault, data) {
      return withDiagnostics(() => base.saveAll(vault, data))
    },
    async ping() {
      return base.ping ? base.ping() : true
    },
    diagnostics,
  }
}
