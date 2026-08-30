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

/**
 * #1227 follow-up — hub's optional `zod` peer must admit BOTH majors.
 *
 * The un-vendoring shipped `zod: ^4.0.0`, which is narrower than what hub
 * actually supports and made `hub + zod@3` ERESOLVE under npm — measured:
 * pre.14 + zod@3 exits 1, pre.14 + zod@4 exits 0, pre.13 + zod@3 exits 0. The
 * DECLARATION changed, not the support.
 *
 * Zod 3 is supported through the `zod-to-json-schema` optional peer, and the
 * v4-native `toJSONSchema` loader falls back when it is absent. Two releases
 * immediately before this one were substantially Zod 3 hardening (the
 * ZodEffects unwrap, `z.preprocess` on both majors), so the investment and the
 * declaration pointed in opposite directions.
 *
 * Asserted here because nothing else executes a peer RANGE: while zod was
 * vendored no resolver ever saw one, and every in-repo gate stays green either
 * way. Same class as the family's exact-peer incident — a peer FORM deciding
 * installability with no test able to see it.
 */
describe('#1227 — the optional zod peer admits both majors', () => {
  it('declares a range covering Zod 3 and Zod 4', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const range = manifest.peerDependencies?.['zod']
    expect(range, 'zod must be declared as a peer').toBeTruthy()
    // Asserted on the OUTPUT domain — "does the range admit a real version of
    // each major" — rather than on the literal string, so a differently
    // spelled but equivalent range passes and a narrowing of either fails.
    // A local caret check, because semver is not a hub dependency and adding
    // one for a test would be a worse trade than eight lines.
    const admitsMajor = (r: string, major: number): boolean =>
      r.split('||').map(c => c.trim()).some((clause) => {
        const m = /^\^(\d+)\./.exec(clause)
        return m !== null && Number(m[1]) === major
      })
    expect(admitsMajor(range!, 3), `zod@3 must satisfy "${range}"`).toBe(true)
    expect(admitsMajor(range!, 4), `zod@4 must satisfy "${range}"`).toBe(true)
    // A range ending in a dangling `||` floors at 0.0.0 and admits everything
    // while looking almost right — the family has shipped that before.
    expect(range!.trim().endsWith('||'), 'range must not end in a dangling ||').toBe(false)
    expect(manifest.peerDependenciesMeta?.['zod']?.optional, 'zod must stay OPTIONAL').toBe(true)
  })
})
