/**
 * Root-barrel rotate/recover symmetry (#992).
 *
 * `#876` narrowed the root barrel and kept `keyringRotateSecret` — the `at-*`
 * / `on-*` satellites bind it — but dropped its recover twin, which now ships
 * only as `recoverSecret` from `@noy-db/hub/team`. The asymmetry reads as
 * "deliberately removed" rather than "moved", so a consumer goes looking for a
 * different API instead of a different import path (reported by niwat-app on
 * the 0.3.0 → 0.6.0-pre.2 hop).
 *
 * The standalone form is the load-bearing one: paper-code recovery runs
 * without a `Noydb` instance, so `db.team.recoverSecret` is not reachable at
 * that point in the flow.
 */
import { describe, it, expect } from 'vitest'
import * as rootBarrel from '../src/index.js'
import { recoverSecret } from '../src/with-party/team/index.js'

describe('root barrel: rotate/recover twins', () => {
  it('exports the recover half alongside keyringRotateSecret', () => {
    expect(rootBarrel).toHaveProperty('keyringRotateSecret')
    expect(rootBarrel).toHaveProperty('keyringRecoverSecret')
  })

  it('is the same standalone function the /team subpath ships', () => {
    expect(rootBarrel.keyringRecoverSecret).toBe(recoverSecret)
  })
})
