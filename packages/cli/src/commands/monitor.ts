/**
 * `noydb monitor <config.ts>` — live text dashboard of store metrics.
 *
 * Loads a `NoydbOptions` from a config file, wraps the primary store
 * in `@noy-db/to-meter`, creates a `Noydb` instance, and prints a
 * refreshing snapshot to stdout at a configurable interval. Ctrl-C
 * to stop.
 *
 * This is the v0.13 scope of issue #199 — CLI-first. A web dashboard
 * is deferred: the meter handle already exposes everything a dashboard
 * needs via `snapshot()` + `subscribe()`.
 *
 * @module
 */
import { toMeter } from '@noy-db/to-meter'
import type { MeterSnapshot } from '@noy-db/to-meter'
import { loadOptionsFromFile } from './config.js'

export interface MonitorOptions {
  intervalMs: number
  iterations?: number    // undefined → run forever
}

export async function runMonitor(argv: readonly string[]): Promise<number> {
  const file = argv[0]
  if (!file) {
    process.stderr.write('usage: noydb monitor <config.ts> [--interval=ms]\n')
    return 2
  }

  const intervalArg = argv.find((a) => a.startsWith('--interval='))
  const intervalMs = intervalArg ? parseInt(intervalArg.split('=')[1] ?? '5000', 10) : 5_000

  let opts: Record<string, unknown>
  try {
    const loaded = await loadOptionsFromFile(file)
    if (typeof loaded !== 'object' || loaded === null) {
      process.stderr.write(`config file must export a NoydbOptions-shaped object\n`)
      return 1
    }
    opts = loaded as Record<string, unknown>
  } catch (err) {
    process.stderr.write(`failed to load ${file}: ${(err as Error).message}\n`)
    return 1
  }

  const innerStore = opts['store']
  if (!innerStore || typeof innerStore !== 'object') {
    process.stderr.write('config has no `store` — nothing to monitor\n')
    return 1
  }

  const { store: metered, meter } = toMeter(innerStore as never, {
    degradedMs: 500,
    onDegraded: (e) => process.stderr.write(`DEGRADED: ${e.reason}\n`),
    onRestored: (e) => process.stderr.write(`RESTORED: ${e.reason}\n`),
  })

  // Replace the store in the options object so the Noydb instance
  // goes through the meter.
  const liveOpts = { ...opts, store: metered } as Record<string, unknown>

  // Dynamically import hub so the CLI doesn't need to bundle it at
  // build time. Adopter's installed @noy-db/hub version wins.
  const hub = await import('@noy-db/hub') as { createNoydb: (o: unknown) => Promise<unknown> }
  await hub.createNoydb(liveOpts)

  process.stdout.write(`monitoring ${file} — interval ${intervalMs}ms — Ctrl-C to stop\n\n`)

  const stop = installSigintHandler(meter)

  return new Promise<number>((resolveP) => {
    const timer = setInterval(() => {
      if (stop.signalled) {
        clearInterval(timer)
        meter.close()
        resolveP(0)
        return
      }
      const snap = meter.snapshot()
      process.stdout.write(formatSnapshot(snap) + '\n')
    }, intervalMs)
  })
}

function installSigintHandler(meter: { close(): void }): { signalled: boolean } {
  const state = { signalled: false }
  const handler = () => { state.signalled = true; meter.close() }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return state
}

export function formatSnapshot(snap: MeterSnapshot): string {
  const lines: string[] = []
  const ts = new Date(snap.collectedAt).toISOString().slice(11, 19)
  lines.push(`[${ts}] status=${snap.status} calls=${snap.totalCalls} casConflicts=${snap.casConflicts} windowMs=${snap.windowMs}`)
  for (const m of ['get', 'put', 'delete', 'list', 'loadAll', 'saveAll'] as const) {
    const s = snap.byMethod[m]
    if (s.count === 0) continue
    lines.push(`  ${m.padEnd(7)} count=${s.count} errors=${s.errors} p50=${s.p50}ms p99=${s.p99}ms max=${s.max}ms avg=${s.avg}ms`)
  }
  return lines.join('\n')
}
