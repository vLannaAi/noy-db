/**
 * **@noy-db/to-ssh** — SSH/SFTP-backed noy-db store.
 *
 * Any Linux/macOS server with `sshd` running becomes a noy-db backend,
 * using the keys already in the operator's `~/.ssh/` or ssh-agent.
 * SFTP — not per-call SCP — keeps the overhead to a single long-lived
 * SSH channel regardless of how many records are read or written.
 *
 * ## Auth — keys only, never passwords
 *
 * Three paths, pick one per store instance:
 *
 *   1. **Private key bytes** — `privateKey: Buffer | string` (optional
 *      `passphrase` for encrypted keys).
 *   2. **Private key file path** — `privateKeyPath: '~/.ssh/id_ed25519'`;
 *      the store reads and decrypts it at connect time.
 *   3. **ssh-agent** — `agent: process.env.SSH_AUTH_SOCK` (default when
 *      no other option is supplied). Leverages the existing keys without
 *      handing them to noy-db at all.
 *
 * Password auth is intentionally **not supported**. A password on the
 * wire defeats the zero-knowledge positioning and offers worse UX than
 * a key.
 *
 * ## Driver — bring your own
 *
 * noy-db does not pull in `ssh2` as a runtime dependency. The consumer
 * installs it (`pnpm add ssh2`) and either passes a connected `Client`
 * directly (shared across adapters) or lets the factory connect one
 * for them. The duck-typed `SftpHandle` interface below accepts any
 * shape that exposes the minimal SFTP verbs we need, so wrappers like
 * `ssh2-sftp-client` work too.
 *
 * ## Atomicity
 *
 * Every put writes to `{id}.json.tmp` then issues `SFTP_RENAME` to
 * `{id}.json`. POSIX rename is atomic, so a concurrent reader cannot
 * observe a half-written record. This does NOT give CAS —
 * `StoreCapabilities.casAtomic` is `false` — but it rules out partial
 * writes on process crash.
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'

/**
 * Duck-typed subset of an SFTP client. Compatible with `ssh2`'s
 * `SFTPWrapper`, `ssh2-sftp-client`'s API, or any custom wrapper that
 * exposes the same async file primitives.
 */
export interface SftpHandle {
  /** Read a file into memory. Returns `null` if the file does not exist. */
  readFile(path: string): Promise<Uint8Array | Buffer | null>
  /** Write a file (create or overwrite). */
  writeFile(path: string, data: Uint8Array | Buffer | string): Promise<void>
  /** Delete a file. Succeeds silently if the file does not exist. */
  unlink(path: string): Promise<void>
  /** Create a directory and all missing parents. */
  mkdir(path: string, recursive?: boolean): Promise<void>
  /**
   * Atomic rename. MUST be atomic against concurrent readers on the
   * same path (POSIX guarantee on same-filesystem renames).
   */
  rename(from: string, to: string): Promise<void>
  /** List entries of a directory. Returns empty when directory is missing. */
  readdir(path: string): Promise<string[]>
  /** Optional liveness check. When missing, the store's `ping` returns `true`. */
  ping?(): Promise<boolean>
}

export interface SshStoreOptions {
  /** Connected SFTP handle — consumer supplies this. */
  readonly sftp: SftpHandle
  /** Remote directory root. Created on first write if missing. Default `'noydb'`. */
  readonly remotePath?: string
  /** Diagnostic name. Default `'ssh'`. */
  readonly name?: string
}

function pathJoin(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .map(p => p.replace(/^\/+|\/+$/g, ''))
    .filter(p => p !== '')
    .join('/')
}

function decode(bytes: Uint8Array | Buffer): string {
  if (typeof Buffer !== 'undefined' && bytes instanceof Buffer) {
    return bytes.toString('utf-8')
  }
  return new TextDecoder().decode(bytes)
}

export function ssh(options: SshStoreOptions): NoydbStore {
  const { sftp, remotePath = 'noydb', name = 'ssh' } = options

  const root = remotePath.replace(/^\/+|\/+$/g, '')
  const recordPath = (v: string, c: string, id: string): string =>
    '/' + pathJoin(root, v, c, `${id}.json`)
  const collPath = (v: string, c: string): string => '/' + pathJoin(root, v, c)
  const vaultPath = (v: string): string => '/' + pathJoin(root, v)

  async function ensureDir(path: string): Promise<void> {
    try {
      await sftp.mkdir(path, true)
    } catch {
      // Either exists, or the caller's mkdir already handles recursive semantics.
    }
  }

  async function safeReaddir(path: string): Promise<string[]> {
    try {
      return await sftp.readdir(path)
    } catch {
      return []
    }
  }

  const store: NoydbStore = {
    name,

    async get(vault, collection, id) {
      const bytes = await sftp.readFile(recordPath(vault, collection, id))
      if (bytes === null) return null
      return JSON.parse(decode(bytes)) as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope) {
      // expectedVersion is intentionally ignored — casAtomic: false for this
      // transport. Consumers needing CAS should route via a store that has it.
      const target = recordPath(vault, collection, id)
      const tmp = `${target}.tmp`
      await ensureDir(collPath(vault, collection))
      await sftp.writeFile(tmp, JSON.stringify(envelope))
      await sftp.rename(tmp, target)
    },

    async delete(vault, collection, id) {
      try {
        await sftp.unlink(recordPath(vault, collection, id))
      } catch {
        // Already gone — delete is idempotent from the caller's POV.
      }
    },

    async list(vault, collection) {
      const entries = await safeReaddir(collPath(vault, collection))
      return entries
        .filter(e => e.endsWith('.json') && !e.endsWith('.tmp'))
        .map(e => e.slice(0, -'.json'.length))
        .sort()
    },

    async loadAll(vault) {
      const snap: VaultSnapshot = {}
      const collections = await safeReaddir(vaultPath(vault))
      for (const collection of collections) {
        if (collection.startsWith('_')) continue
        const ids = await store.list(vault, collection)
        const bucket: Record<string, EncryptedEnvelope> = {}
        for (const id of ids) {
          const env = await store.get(vault, collection, id)
          if (env) bucket[id] = env
        }
        if (Object.keys(bucket).length > 0) snap[collection] = bucket
      }
      return snap
    },

    async saveAll(vault, data) {
      // Delete the vault tree first to mirror the semantics of other stores.
      const existingCollections = await safeReaddir(vaultPath(vault))
      for (const collection of existingCollections) {
        const ids = await safeReaddir(collPath(vault, collection))
        for (const id of ids) {
          await sftp
            .unlink('/' + pathJoin(root, vault, collection, id))
            .catch(() => undefined)
        }
      }
      // Write the new tree.
      for (const [collection, recs] of Object.entries(data)) {
        await ensureDir(collPath(vault, collection))
        for (const [id, envelope] of Object.entries(recs)) {
          await store.put(vault, collection, id, envelope)
        }
      }
    },

    async ping() {
      if (sftp.ping) return sftp.ping()
      // Default liveness: list the root. If sshd is alive and reachable,
      // this returns something; on a dead connection it throws.
      try {
        await sftp.readdir('/' + root)
        return true
      } catch {
        return false
      }
    },
  }

  return store
}
