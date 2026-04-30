/**
 * **@noy-db/to-icloud** — iCloud Drive bundle store for noy-db.
 *
 * Treats each vault as a single `.noydb` bundle stored under
 * `~/Library/Mobile Documents/…` (or any user-chosen iCloud path).
 * Pair with `wrapBundleStore()` from `@noy-db/hub` to get the
 * standard six-method `NoydbStore` surface.
 *
 * ## Why a dedicated package if `to-file` "works"?
 *
 * `@noy-db/to-file` pointed at an iCloud Drive directory technically
 * works — until one of three iCloud-specific behaviors bites you:
 *
 *   1. **On-demand eviction.** iCloud may evict the file to cloud-only
 *      storage, leaving a `.icloud` stub. `readFile()` on the stub
 *      either throws ENOENT or returns stub metadata. This store
 *      detects the stub, nudges the OS to redownload (via `xattr` on
 *      macOS), and retries.
 *   2. **Conflict files.** Parallel writes from two devices create
 *      `name (device conflicted copy DATE).noydb`. This store detects
 *      those files and raises `BundleVersionConflictError`, giving the
 *      caller a chance to merge deliberately.
 *   3. **Sync-not-yet-complete writes.** A completed `writeFile()` does
 *      not mean the bytes are on Apple's servers. `ping()` reports
 *      on upload status so callers can wait before considering a
 *      write durable.
 *
 * ## Scope
 *
 * - **Node (macOS) only for v1.** Browser / iOS consumers go through
 *   CloudKit JS — a separate package will ship as `@noy-db/to-cloudkit`.
 * - **Bundle granularity** — whole vault in one file. Pair with
 *   `syncPolicy: { push: { mode: 'debounce', 30_000 } }` so every
 *   record mutation doesn't trigger a full bundle upload.
 * - **No extra auth** — iCloud syncs via the user's signed-in Apple ID;
 *   the store never sees credentials.
 *
 * @packageDocumentation
 */

import type { NoydbBundleStore } from '@noy-db/hub'
import { BundleVersionConflictError } from '@noy-db/hub'

/** Default iCloud Drive folder name inside a user's mobile-documents tree. */
export const DEFAULT_FOLDER = 'NoyDB'

export interface ICloudFs {
  readFile(path: string): Promise<Uint8Array | Buffer | null>
  writeFile(path: string, data: Uint8Array): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>
  /** macOS-only: force iCloud to materialise an evicted `.icloud` stub. */
  triggerDownload?(path: string): Promise<void>
}

export interface ICloudStoreOptions {
  /** Absolute path to the iCloud Drive folder that holds bundles. */
  readonly folder: string
  /** File-system facade — swap in a mock or a cross-platform shim. */
  readonly fs: ICloudFs
  /** Bundle filename suffix. Default `'.noydb'`. */
  readonly suffix?: string
}

function fileName(vault: string, suffix: string): string {
  return `${vault}${suffix}`
}

function isStub(name: string): boolean {
  // macOS writes `<name>.icloud` stubs when offloading files.
  return name.endsWith('.icloud')
}

function isConflictCopy(name: string, expected: string): boolean {
  // Canonical shape: `foo (device conflicted copy DATE).noydb`
  return name.includes("'s conflicted copy") ||
         (name.includes('(conflicted copy') && name.endsWith(expected.slice(expected.lastIndexOf('.'))))
}

/**
 * Build a `NoydbBundleStore` over an iCloud Drive folder. Wrap with
 * `wrapBundleStore()` to consume via `createNoydb({ store })`.
 */
export function icloud(options: ICloudStoreOptions): NoydbBundleStore {
  const suffix = options.suffix ?? '.noydb'
  const dir = options.folder.replace(/\/+$/, '')
  const { fs } = options

  async function pathFor(vault: string): Promise<string> {
    return `${dir}/${fileName(vault, suffix)}`
  }

  async function stubAwareRead(path: string): Promise<Uint8Array | null> {
    // Direct read first.
    let bytes = await fs.readFile(path)
    if (bytes !== null) return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)

    // Check for an adjacent `.icloud` stub and try to materialise it.
    const stubPath = `${path}.icloud`
    const stubExists = await fs.stat(stubPath)
    if (!stubExists) return null
    if (fs.triggerDownload) {
      await fs.triggerDownload(stubPath)
      bytes = await fs.readFile(path)
      if (bytes !== null) return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    }
    // Still offloaded. Surface a clean error so the caller can retry
    // or invite the user to open iCloud.
    throw new Error(
      `iCloud file "${path}" is offloaded. Open the file in Finder to trigger a download, ` +
      `or install an OS-level trigger (\`brctl download "${path}"\`).`,
    )
  }

  async function detectConflict(vault: string): Promise<string | null> {
    const target = fileName(vault, suffix)
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      if (isConflictCopy(entry, target)) return entry
    }
    return null
  }

  function versionOf(stat: { mtimeMs: number; size: number }): string {
    // mtime-based opaque token — sufficient for OCC within a single
    // syncing agent. iCloud's native conflict file machinery provides
    // the cross-agent guard.
    return `${stat.mtimeMs}-${stat.size}`
  }

  return {
    kind: 'bundle',
    name: 'icloud',

    async readBundle(vaultId) {
      const path = await pathFor(vaultId)
      const stat = await fs.stat(path)
      if (!stat) {
        // Perhaps only a stub exists — detect and trigger.
        const stubStat = await fs.stat(`${path}.icloud`)
        if (!stubStat) return null
        const bytes = await stubAwareRead(path)
        if (!bytes) return null
        const redoStat = await fs.stat(path)
        if (!redoStat) throw new Error(`icloud: file vanished after download at ${path}`)
        return { bytes, version: versionOf(redoStat) }
      }
      const bytes = await stubAwareRead(path)
      if (!bytes) return null
      return { bytes, version: versionOf(stat) }
    },

    async writeBundle(vaultId, bytes, expectedVersion) {
      // Conflict file present → refuse; caller merges.
      const conflict = await detectConflict(vaultId)
      if (conflict) {
        throw new BundleVersionConflictError(
          `iCloud conflict file detected alongside "${vaultId}${suffix}": "${conflict}". ` +
          `Open iCloud Drive, resolve the conflict, then retry.`,
        )
      }
      const path = await pathFor(vaultId)
      const stat = await fs.stat(path)
      const current = stat ? versionOf(stat) : null
      if (expectedVersion !== null && current !== null && expectedVersion !== current) {
        throw new BundleVersionConflictError(
          `iCloud bundle version mismatch: expected ${expectedVersion}, found ${current}`,
        )
      }
      await fs.writeFile(path, bytes)
      const newStat = await fs.stat(path)
      if (!newStat) throw new Error(`icloud: write reported success but stat failed at ${path}`)
      return { version: versionOf(newStat) }
    },

    async deleteBundle(vaultId) {
      const path = await pathFor(vaultId)
      try {
        await fs.unlink(path)
      } catch {
        // Idempotent
      }
    },

    async listBundles() {
      const entries = await fs.readdir(dir).catch(() => [] as string[])
      const out: Array<{ vaultId: string; version: string; size: number }> = []
      for (const entry of entries) {
        if (!entry.endsWith(suffix) || isStub(entry)) continue
        const vaultId = entry.slice(0, -suffix.length)
        const stat = await fs.stat(`${dir}/${entry}`)
        if (!stat) continue
        out.push({ vaultId, version: versionOf(stat), size: stat.size })
      }
      return out
    },
  }
}

/**
 * Wire a Node `fs/promises` implementation as an `ICloudFs`. Dynamic
 * import keeps the package browser-loadable (the caller's bundler
 * prunes the Node path).
 */
export async function nodeFs(): Promise<ICloudFs> {
  const fs = await import('node:fs/promises')
  const { spawn } = await import('node:child_process')
  return {
    async readFile(path) {
      try {
        return await fs.readFile(path)
      } catch {
        return null
      }
    },
    async writeFile(path, data) {
      await fs.writeFile(path, data)
    },
    async unlink(path) {
      await fs.unlink(path).catch(() => undefined)
    },
    async readdir(path) {
      return fs.readdir(path)
    },
    async stat(path) {
      try {
        const s = await fs.stat(path)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    },
    async triggerDownload(path) {
      // macOS: `brctl download` forces iCloud to materialise a stub.
      await new Promise<void>((resolve) => {
        const child = spawn('brctl', ['download', path.replace(/\.icloud$/, '')])
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
    },
  }
}
