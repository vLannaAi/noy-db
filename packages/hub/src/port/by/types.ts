/**
 * Kernel coordination port — the injected `NoydbMesh` seam for the
 * schema-fence drain-barrier.
 *
 * The kernel defines this port; `@noy-db/by-tabs` / `@noy-db/by-peer` implement
 * it for real-time quorum, and an external orchestrator (`@klum-db/lobby`)
 * drives it through the `Noydb` handle without ever naming a `by-*` package.
 * The dependency arrow is `by-* → kernel ← klum`, the app at the apex.
 *
 * This module carries only the port TYPES plus two pure-ish helpers:
 * {@link isQuorum} (a pure quorum predicate extracted from the legacy
 * `activeQuiesced`) and {@link runDrainBarrier} (the reusable barrier protocol
 * the migration cutover and klum both call).
 *
 * @module
 */

import { QuiesceTimeoutError } from '../../kernel/errors.js'
import type { Unsubscribe } from '../with/write-hooks.js'
import type { FenceDoc } from '../../with-shape/schema-update/fence.js'

/**
 * What the mesh carries about the fence: the vault's schema generation and its
 * drain phase. This is the vault's OWN fence document — `@noy-db/hub/by`
 * re-exports it rather than declaring a parallel type.
 *
 * Through 0.6 this port declared its own `FenceState` interface with the same
 * two fields. Two problems, and only the first was visible (#1188):
 *
 *  1. `FenceState` ALSO names an unrelated string union
 *     (`'normal' | 'draining' | …`) on `.` and `./cargo`. A consumer importing
 *     from `@noy-db/hub` and one importing from `@noy-db/hub/by` got different
 *     types, both compiling, failing only where they met.
 *  2. It was a hand-copy — its own comment said "the existing FenceDoc shape" —
 *     and it had already drifted, missing the `schemaHash` field #946 added.
 *     Measured mutually assignable with `FenceDoc` under `--strict
 *     --exactOptionalPropertyTypes`, so there was no type to preserve.
 *
 * Re-exporting fixes both: one name, one meaning, one definition to keep
 * current. `FenceState` on the root barrel is untouched and still means the
 * string union.
 */
export type { FenceDoc }


/** A writer's presence + ack, tagged with the session that owns it. */
export interface WriterPresence {
  /** = today's clientId (one per tab/peer). */
  readonly writerId: string
  /** Groups one user's writers across vaults (consolidation is klum's job). */
  readonly sessionId: string
  readonly lastSeen: number
  readonly quiescedAtVersion: number | null
}

/** Session-addressable drain-barrier coordination transport. Per-vault ops. */
export interface NoydbMesh {
  /** orchestrator → all writers */
  setFence(vault: string, fence: FenceDoc): Promise<void>
  /**
   * Fresh one-shot fence read for the write-path gate (`assertWritable`).
   * A direct read (not a cached `observeFence` snapshot) avoids a staleness
   * window and keeps the timing-sensitive cutover gate exact. The store
   * default reads `_meta/schema-fence`; `by-*` return their last-pushed fence.
   */
  readFence(vault: string): Promise<FenceDoc>
  /** writer observes fence changes (default: poll-emit; by-*: push) */
  observeFence(vault: string, onChange: (f: FenceDoc) => void): Unsubscribe
  /** writer → orchestrator: presence + ack (heartbeat + quiescedAtVersion) */
  reportPresence(vault: string, p: WriterPresence): Promise<void>
  /** orchestrator observes presence changes (default: poll-emit; by-*: push) */
  observePresence(vault: string, onChange: (writers: readonly WriterPresence[]) => void): Unsubscribe
  /** orchestrator one-shot snapshot of reachable writers (quorum input) */
  reachableWriters(vault: string, o: { staleMs: number; now: number }): Promise<readonly WriterPresence[]>
}

/**
 * Pure quorum predicate: true when every writer (other than `excludeWriterId`)
 * has acked at exactly `generation`. An empty set is trivially a quorum.
 *
 * Extracted from the legacy `activeQuiesced` store-polling check so the
 * migration cutover, the store default provider, and `by-*` real-time
 * providers all share one definition of "everyone has drained".
 */
export function isQuorum(
  writers: readonly WriterPresence[],
  generation: number,
  excludeWriterId?: string,
): boolean {
  return writers.filter((w) => w.writerId !== excludeWriterId).every((w) => w.quiescedAtVersion === generation)
}

/** Inputs for {@link runDrainBarrier}. */
export interface DrainBarrierOptions {
  readonly vault: string
  readonly generation: number
  readonly writerId: string
  readonly onFlush: () => Promise<void>
  readonly staleMs: number
  readonly quiesceTimeoutMs: number
  readonly now: () => number
  /** Optional seam (mainly for deterministic tests) run before each poll tick. */
  readonly onPoll?: () => Promise<void>
}

/**
 * The reusable drain-barrier protocol shared by the migration cutover and klum:
 *
 *   drain self → setFence(draining) → await quorum (presence push + isQuorum,
 *   polling as a fallback, or timeout) → run() → release-by-caller.
 *
 * Resolves once every reachable writer (excluding `writerId`) has quiesced at
 * `generation`, at which point `run` is invoked exactly once. Rejects with
 * {@link QuiesceTimeoutError} if `quiesceTimeoutMs` elapses first.
 */
export async function runDrainBarrier(
  provider: NoydbMesh,
  o: DrainBarrierOptions,
  run: () => Promise<void>,
): Promise<void> {
  await provider.setFence(o.vault, { currentSchemaVersion: o.generation, fenceState: 'draining' })
  await o.onFlush()

  const deadline = o.now() + o.quiesceTimeoutMs
  const seeded = await provider.reachableWriters(o.vault, { staleMs: o.staleMs, now: o.now() })
  if (!isQuorum(seeded, o.generation, o.writerId)) {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (!settled) {
          settled = true
          unsub()
          fn()
        }
      }
      const unsub = provider.observePresence(o.vault, (writers) => {
        if (isQuorum(writers, o.generation, o.writerId)) finish(resolve)
      })
      const tick = async () => {
        if (settled) return
        if (o.now() >= deadline) {
          finish(() =>
            reject(
              new QuiesceTimeoutError(
                `Cutover of vault "${o.vault}" to generation ${o.generation} timed out ` +
                  `after ${o.quiesceTimeoutMs}ms waiting for active writers to quiesce.`,
              ),
            ),
          )
          return
        }
        if (o.onPoll) await o.onPoll()
        const w = await provider.reachableWriters(o.vault, { staleMs: o.staleMs, now: o.now() })
        if (isQuorum(w, o.generation, o.writerId)) finish(resolve)
        else setTimeout(() => void tick(), 25)
      }
      void tick()
    })
  }
  await run()
}
