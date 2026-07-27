/**
 * Multi-user team capability contract (#267 Track A tail — the
 * keyring-grant → team split). Lives on the `/with` port (the one seam the
 * kernel spine may import statically) so `Noydb` can hold the `NO_TEAM`
 * floor default without a spine→service static import.
 *
 * The active engine (`withTeam()` in `with-party/team/active.ts`)
 * statically links the grant/revoke/rotate keyring engines from
 * `keyring.ts` — bundle-charged to consumers of the `@noy-db/hub/team`
 * subpath, never to the single-user floor. {@link NO_TEAM} (the floor
 * default) throws {@link TeamNotEnabledError}.
 *
 * `Noydb.grant` / `Noydb.revoke` / `Noydb.rotate` delegate here, passing
 * their `TeamFacade` — the facade owns the policy-gate + keyring plumbing
 * (`runGrant` / `runRevoke` / `runRotate`) and receives the engine as an
 * argument from the strategy.
 *
 * Deliberately NOT gated (single-user primitives): owner keyring creation,
 * unlock, `listUsers`, `updateUser`, secret rotate/recover, and the
 * `createDeedOwner` free function (no createNoydb instance to gate against —
 * the same carve-out as `liberateVault`).
 * @internal
 */
import type { GrantOptions, RevokeOptions, FactorProofBundle } from '../../kernel/types.js'
import type { RotateResult } from '../../with-party/team/keyring.js'
import { TeamNotEnabledError } from '../../kernel/errors.js'
import type { TeamFacade } from '../../with-party/team/noydb-facade.js'

export interface TeamStrategy {
  grant(team: TeamFacade, vault: string, options: GrantOptions, factors?: FactorProofBundle): Promise<void>
  revoke(team: TeamFacade, vault: string, options: RevokeOptions, factors?: FactorProofBundle): Promise<void>
  rotate(team: TeamFacade, vault: string, collections: string[]): Promise<RotateResult>
}

/**
 * No-op stub — the floor default. Every multi-user team operation throws
 * {@link TeamNotEnabledError}; opt in with `teamStrategy: withTeam()` in
 * createNoydb. @internal
 */
export const NO_TEAM: TeamStrategy = {
  async grant() { throw new TeamNotEnabledError() },
  async revoke() { throw new TeamNotEnabledError() },
  async rotate() { throw new TeamNotEnabledError() },
}
