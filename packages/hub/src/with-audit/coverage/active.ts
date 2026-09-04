/**
 * `withCoverage()` — the opt-in read-coverage sensor (#1363).
 *
 * ⛔⛔ **Against an insider holding the device and local keys, this prevents
 * nothing. It makes bulk extraction visible early, attributable and loud. It
 * is telemetry.** The real remediation is key custody — tiers and
 * per-collection DEKs — and this factory is not a substitute for one. Read the
 * sentence again before wiring it into anything that describes itself as a
 * control.
 *
 * @module
 */

import { CoverageRegistry } from './accounting.js'
import type { WithCoverageOptions } from './accounting.js'

/**
 * Enable coverage accounting for every collection that declares a
 * `bulk: 'sensitive'` field (or that is named in `opts.collections`).
 *
 * ```ts
 * const coverage = withCoverage({ collections: { clients: { corpusSize: 1200, alertAt: [0.6, 0.9] } } })
 * const db = await createNoydb({ user: 'alice', secret, coverageStrategy: coverage })
 * db.on('coverage:threshold', (e) => notifyOwner(e))   // a SIGNAL, never a refusal
 * ```
 *
 * The returned registry is the strategy AND the read surface: `stats()` for a
 * live view, `snapshot()`/`restore()` to carry the coverage horizon across a
 * restart. Nothing it returns can name a record that was read.
 */
export function withCoverage(opts: WithCoverageOptions = {}): CoverageRegistry {
  return new CoverageRegistry(opts)
}
