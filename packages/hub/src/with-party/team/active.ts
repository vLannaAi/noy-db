/**
 * Enable the multi-user team capability (#267 Track A tail).
 *
 * Pass to `createNoydb({ teamStrategy: withTeam() })` to make `db.grant` /
 * `db.revoke` / `db.rotate` live. The keyring grant/revoke/rotate engines
 * are statically imported HERE — this module is reachable only through the
 * `@noy-db/hub/team` subpath (and the root barrel's tree-shakeable
 * re-export), so a single-user floor bundle never carries them. The facade
 * (`TeamFacade.runGrant` / `runRevoke` / `runRotate`) owns the policy-gate +
 * keyring plumbing and receives the engine as an argument.
 */
import type { TeamStrategy } from './strategy.js'
import { grant as grantEngine, revoke as revokeEngine, rotateKeys as rotateEngine, verifyRoster as verifyRosterEngine, quarantineKeyring as quarantineEngine } from './keyring.js'

export function withTeam(): TeamStrategy {
  return {
    async grant(team, vault, options, factors) {
      return team.runGrant(grantEngine, vault, options, factors)
    },
    async revoke(team, vault, options, factors) {
      return team.runRevoke(revokeEngine, vault, options, factors)
    },
    async rotate(team, vault, collections) {
      return team.runRotate(rotateEngine, vault, collections)
    },
    async verifyRoster(team, vault) {
      return team.runVerifyRoster(verifyRosterEngine, vault)
    },
    async quarantineKeyring(team, vault, userId, factors) {
      return team.runQuarantine(quarantineEngine, vault, userId, factors)
    },
  }
}
