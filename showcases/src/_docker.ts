/**
 * Local-docker-compose gate helper for storage real-provider showcases.
 *
 * Sister to `_env.ts`. Where `_env.ts` checks "do you have credentials
 * for the cloud-hosted service?", `_docker.ts` checks "is the local
 * docker-compose stack actually up *and* serving on the expected port?"
 *
 * Why a separate helper
 * ─────────────────────
 * Cloud showcases skip cleanly when env vars are unset — the typical
 * developer never had credentials at all. Docker showcases have a
 * different failure mode: env vars are set (the developer wants to
 * test) but the container is not running yet (`pnpm docker:up`
 * hasn't been invoked, or it crashed). A pure env-var gate would
 * report a green "skipped" while the dev clearly intended otherwise.
 *
 * Solution: combine the env-var check with a 1-second TCP connect
 * probe against the published port. A closed port produces a
 * descriptive skip hint that says "container is down, run `pnpm
 * docker:up`" — a more actionable message than "test passed".
 *
 * Uses
 * ────
 *   const gate = await dockerGate('mysql')
 *   describe.skipIf(!gate.enabled)(...)
 *   await runStoreConformanceTests({
 *     storeFactory: () => mysql({ ... gate.values ... }),
 *   })
 *
 * Bring-up command
 * ────────────────
 *   pnpm docker:up
 *   # or directly:
 *   docker compose -f showcases/docker-compose.yml up -d
 *
 * @module
 */

import { createConnection } from 'node:net'
import { envGate, logSkipHint, type EnvGate } from './_env.js'

/**
 * Service identifier — must match a service block in
 * `showcases/docker-compose.yml`. The mapping below pins the
 * (env-vars × host port) pair per service.
 */
export type DockerService = 'mysql' | 'sshd' | 'samba' | 'nfs'

interface DockerServiceConfig {
  readonly label: string
  readonly vars: readonly string[]
  /** Host port to probe for readiness. Mirrors compose `ports:` mapping. */
  readonly port: number
  /** Hint surfaced when the gate is closed. */
  readonly hint: string
}

const SERVICES: Record<DockerService, DockerServiceConfig> = {
  mysql: {
    label: 'to-mysql (docker)',
    vars: ['NOYDB_SHOWCASE_MYSQL_URL'],
    port: 3307,
    hint:
      'Set NOYDB_SHOWCASE_MYSQL_URL=mysql://root:noydb-showcase@localhost:3307/noydb_showcase ' +
      'in showcases/.env, then run `pnpm docker:up`.',
  },
  sshd: {
    label: 'to-ssh (docker)',
    vars: [
      'NOYDB_SHOWCASE_SSH_HOST',
      'NOYDB_SHOWCASE_SSH_USER',
      'NOYDB_SHOWCASE_SSH_KEY_PATH',
      'NOYDB_SHOWCASE_SSH_REMOTE_DIR',
    ],
    port: 2222,
    hint:
      'Set NOYDB_SHOWCASE_SSH_* in showcases/.env (host=localhost, user=noydb, port=2222, ' +
      'remote_dir=/config/noydb-showcase, key_path=showcases/fixtures/ssh-test-key), ' +
      'generate the keypair (ssh-keygen -t ed25519 -N \'\' -f showcases/fixtures/ssh-test-key), ' +
      'then run `pnpm docker:up`.',
  },
  samba: {
    label: 'to-smb (docker)',
    vars: [
      'NOYDB_SHOWCASE_SMB_SERVER',
      'NOYDB_SHOWCASE_SMB_SHARE',
      'NOYDB_SHOWCASE_SMB_USERNAME',
      'NOYDB_SHOWCASE_SMB_PASSWORD',
    ],
    port: 1445,
    hint:
      'Set NOYDB_SHOWCASE_SMB_* in showcases/.env (server=localhost:1445, share=noydb, ' +
      'username=noydb, password=testpass), then run `pnpm docker:up`.',
  },
  nfs: {
    label: 'to-nfs (docker)',
    vars: ['NOYDB_SHOWCASE_NFS_MOUNT'],
    port: 2049,
    hint:
      'Set NOYDB_SHOWCASE_NFS_MOUNT to the host-side mount path, run `pnpm docker:up`, ' +
      'then `sudo mount -t nfs -o nfsvers=4.2,rw localhost:/exports/noydb /mnt/noydb-showcase` ' +
      '(or your chosen mount point).',
  },
}

/**
 * Probe a TCP port with a short timeout. Returns `true` iff a
 * connect within `timeoutMs` succeeded. Used to disambiguate
 * "container is down" from "credentials missing".
 */
export async function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port })
    const cleanup = (ok: boolean): void => {
      socket.removeAllListeners()
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    const timer = setTimeout(() => cleanup(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      cleanup(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      cleanup(false)
    })
  })
}

/**
 * Combined gate object — only `enabled` when env vars are set AND
 * the service port is reachable. Logs a hint when either condition
 * fails so the developer knows what to fix.
 */
export interface DockerGate extends EnvGate {
  readonly service: DockerService
  readonly port: number
  /** Reason the gate is closed — useful for diagnostic logging. */
  readonly closedReason?: 'env-missing' | 'port-down'
}

/**
 * Build a docker-aware gate for `service`. Awaits a 1s port probe.
 * Skips the probe when env vars are missing — no point opening a
 * TCP connection when we already know the showcase will skip.
 */
export async function dockerGate(service: DockerService): Promise<DockerGate> {
  const cfg = SERVICES[service]
  const env = envGate({ label: cfg.label, vars: cfg.vars })
  if (!env.enabled) {
    logSkipHint(cfg.label, env, cfg.vars)
    // eslint-disable-next-line no-console
    console.info(`[${cfg.label}] hint: ${cfg.hint}`)
    return { ...env, service, port: cfg.port, closedReason: 'env-missing' }
  }
  const portOk = await probePort('localhost', cfg.port)
  if (!portOk) {
    // eslint-disable-next-line no-console
    console.info(
      `[${cfg.label}] Skipping — env vars set but localhost:${String(cfg.port)} is not reachable. ` +
        `Run \`pnpm docker:up\` to bring up the stack. Hint: ${cfg.hint}`,
    )
    return { ...env, enabled: false, service, port: cfg.port, closedReason: 'port-down' }
  }
  return { ...env, service, port: cfg.port }
}
