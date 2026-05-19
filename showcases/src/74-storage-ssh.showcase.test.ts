/**
 * Showcase 74 — Storage: SSH/SFTP (real-service via local docker-compose)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-ssh` lays each encrypted envelope down as a JSON file
 * over SFTP, one per record under
 * `<remotePath>/<vault>/<collection>/<id>.json`. Writes go to a
 * `.tmp` companion and `SFTP_RENAME` to the target — POSIX atomic
 * rename rules out partial-write corruption on process crash. **CAS
 * is intentionally not supported** (`casAtomic: false`); `to-ssh`
 * is for direct-to-server document sync, not multi-writer arbitration.
 *
 * Why it matters
 * ──────────────
 * Real SSH servers vary in subtle ways the package's `mockSftp()`
 * cannot emulate: the `mkdir(path, recursive)` flag is honoured by
 * OpenSSH but ignored by some embedded NAS sshd builds; `readdir`
 * returns different shapes (string vs `{ filename, attrs }` records)
 * across `ssh2-sftp-client` versions; `rename` semantics differ
 * between SFTP v3 and v6. Driving a real `sshd` container catches
 * these.
 *
 * Auth path: **public-key only.** Password auth is a deliberate
 * non-feature (zero-knowledge positioning + worse UX). The fixture
 * keypair lives at `showcases/fixtures/ssh-test-key`; `.gitignore`
 * excludes the private half. Generate it once before the first run:
 *
 *     ssh-keygen -t ed25519 -N '' -f showcases/fixtures/ssh-test-key
 *
 * Prerequisites
 * ─────────────
 * - Docker / `docker compose` available locally.
 * - Generate the keypair (see above).
 * - Bring up the stack: `pnpm docker:up`. The OpenSSH service binds
 *   to **host port 2222** and is configured for public-key auth
 *   only.
 * - Set the four `NOYDB_SHOWCASE_SSH_*` vars in `showcases/.env`:
 *
 *     NOYDB_SHOWCASE_SSH_HOST=localhost:2222
 *     NOYDB_SHOWCASE_SSH_USER=noydb
 *     NOYDB_SHOWCASE_SSH_KEY_PATH=showcases/fixtures/ssh-test-key
 *     NOYDB_SHOWCASE_SSH_REMOTE_DIR=/config/noydb-showcase
 *
 * What to read next
 * ─────────────────
 *   - showcase 02-storage-file (the local-disk parallel)
 *   - docs/packages/stores.md → "to-ssh" entry
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-ssh
 *
 * Acceptance (per #70)
 * ────────────────────
 *   ✓ Storage round-trip green against real sshd container
 *   ✓ Atomic-write rename pattern verified (no `.tmp` survives)
 *   ✓ Skipped with hint when stack is down or env vars unset
 *   ✓ No private key committed unencrypted (the .pub half is fine)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createNoydb, type EncryptedEnvelope } from '@noy-db/hub'
import { ssh, type SftpHandle } from '@noy-db/to-ssh'
import { dockerGate } from './_docker.js'

const gate = await dockerGate('sshd')

interface Note { id: string; text: string }

const RUN_ID = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
const VAULT_NAME = `showcase-74-${RUN_ID}`

// ssh2-sftp-client is the lazy import — saves a hard module-load
// failure when `playwright` etc. is uninstalled. Wrapped into a
// minimal `SftpHandle`-conforming shim because the package's
// `readdir` returns a different shape than `to-ssh` expects.
type Sftp2Client = {
  connect(opts: {
    host: string; port: number; username: string; privateKey: Buffer
  }): Promise<unknown>
  end(): Promise<unknown>
  get(path: string): Promise<Buffer | string>
  put(input: Buffer | string, dest: string): Promise<unknown>
  delete(path: string): Promise<unknown>
  mkdir(path: string, recursive?: boolean): Promise<unknown>
  rename(from: string, to: string): Promise<unknown>
  list(path: string): Promise<ReadonlyArray<{ name: string }>>
  exists(path: string): Promise<false | 'd' | '-' | 'l'>
}

let client: Sftp2Client | null = null
let handle: SftpHandle | null = null

beforeAll(async () => {
  if (!gate.enabled) return
  // ssh2-sftp-client ships no .d.ts; cast through `unknown` so we
  // don't need the optional `@types/ssh2-sftp-client` package.
  const driver = (await import('ssh2-sftp-client' as string)) as unknown as { default?: unknown } & Record<string, unknown>
  const Ctor = (driver.default ?? driver) as unknown as new () => Sftp2Client
  client = new Ctor()

  // Parse host:port into the components ssh2-sftp-client wants.
  const hostStr = gate.values['NOYDB_SHOWCASE_SSH_HOST']!
  const [host, portStr] = hostStr.includes(':') ? hostStr.split(':') as [string, string] : [hostStr, '22']
  const username = gate.values['NOYDB_SHOWCASE_SSH_USER']!
  const keyPath = gate.values['NOYDB_SHOWCASE_SSH_KEY_PATH']!
  const remoteDir = gate.values['NOYDB_SHOWCASE_SSH_REMOTE_DIR']!

  const privateKey = await readFile(keyPath)
  await client.connect({ host, port: Number(portStr), username, privateKey })

  // Adapt ssh2-sftp-client to `SftpHandle`. Three shape diffs:
  //   1. `readFile` → `get` returns Buffer (ok) but throws on missing;
  //      we swallow ENOENT and return null per the SftpHandle contract.
  //   2. `readdir` returns `{ name: string, ... }[]`; we extract the
  //      name field.
  //   3. `mkdir(path, recursive)` matches; ssh2-sftp-client honours
  //      the second arg.
  handle = {
    async readFile(path) {
      try {
        const data = await client!.get(path)
        return typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
      } catch (err) {
        // ssh2-sftp-client surfaces the SFTP protocol's
        // SSH_FX_NO_SUCH_FILE (code 2) as a numeric `code` AND with
        // 'No such file' in the message. Treat both as null-return
        // per the SftpHandle contract.
        const e = err as { code?: number | string; message?: string }
        if (e.code === 2 || e.code === '2' || (e.message ?? '').includes('No such file')) return null
        throw err
      }
    },
    async writeFile(path, data) {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
      await client!.put(buf, path)
    },
    async unlink(path) {
      try { await client!.delete(path) } catch { /* idempotent */ }
    },
    async mkdir(path, recursive) {
      try { await client!.mkdir(path, recursive ?? true) } catch { /* exists */ }
    },
    async rename(from, to) {
      // Some SFTP servers reject rename onto an existing target; the
      // openssh-server image accepts it, matching to-ssh's
      // SFTP_RENAME contract.
      await client!.rename(from, to)
    },
    async readdir(path) {
      try {
        const entries = await client!.list(path)
        return entries.map((e) => e.name)
      } catch { return [] }
    },
    async ping() {
      try { return (await client!.exists('/')) !== false } catch { return false }
    },
  }

  // Pre-create the remote root — ssh2-sftp-client's mkdir is
  // recursive but the test fixture path may live a few levels deep.
  await handle.mkdir(remoteDir, true)
})

afterAll(async () => {
  if (client) {
    try { await client.end() } catch { /* swallow */ }
  }
})

describe.skipIf(!gate.enabled)('Showcase 74 — Storage: SSH/SFTP (docker)', () => {
  it('round-trips records through real sshd via SFTP + public-key auth', async () => {
    const remoteDir = gate.values['NOYDB_SHOWCASE_SSH_REMOTE_DIR']!
    const store = ssh({
      sftp: handle!,
      remotePath: `${remoteDir.replace(/^\/+|\/+$/g, '')}/${VAULT_NAME}-records`,
    })

    const db = await createNoydb({
      store, user: 'alice',
      secret: 'storage-ssh-passphrase-2026 keystone reach',
    })
    const vault = await db.openVault('default')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'over sftp' })
    await notes.put('b', { id: 'b', text: 'still over sftp' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'over sftp' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('atomic rename — no `.tmp` survives a successful write', async () => {
    const remoteDir = gate.values['NOYDB_SHOWCASE_SSH_REMOTE_DIR']!
    const ROOT = `${remoteDir.replace(/^\/+|\/+$/g, '')}/${VAULT_NAME}-atomic`
    const store = ssh({ sftp: handle!, remotePath: ROOT })

    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(),
      _iv: 'AAAAAAAAAAAAAAAA',
      _data: Buffer.from('opaque-ciphertext-bytes').toString('base64'),
    }
    await store.put('default', 'docs', 'rec-1', env)

    // Inspect the directory directly. The store wrote `rec-1.json`
    // via `writeFile -> rec-1.json.tmp` followed by `rename`. If the
    // rename failed silently, both files would be present; if the
    // rename succeeded, only `.json` remains.
    const entries = await handle!.readdir(`/${ROOT}/default/docs`)
    const jsonFiles = entries.filter((e) => e.endsWith('.json'))
    const tmpFiles = entries.filter((e) => e.endsWith('.tmp'))
    expect(jsonFiles).toEqual(['rec-1.json'])
    expect(tmpFiles).toEqual([])
  })

  it('delete is idempotent across two calls', async () => {
    const remoteDir = gate.values['NOYDB_SHOWCASE_SSH_REMOTE_DIR']!
    const store = ssh({
      sftp: handle!,
      remotePath: `${remoteDir.replace(/^\/+|\/+$/g, '')}/${VAULT_NAME}-idempotent`,
    })
    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(),
      _iv: 'AAAAAAAAAAAAAAAA', _data: 'opaque',
    }
    await store.put('v', 'c', 'x', env)
    await expect(store.delete('v', 'c', 'x')).resolves.not.toThrow()
    // Already gone — second delete must succeed silently.
    await expect(store.delete('v', 'c', 'x')).resolves.not.toThrow()
    expect(await store.get('v', 'c', 'x')).toBeNull()
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(`[to-ssh (docker)] Using vault prefix=${VAULT_NAME}`)
}
