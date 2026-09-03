/**
 * Which `packages/*` members the lockstep normaliser moves (#1313).
 *
 * Membership is WORKSPACE membership, not a name shape. The previous rule,
 * `name.startsWith('@noy-db/')`, skipped `create-noy-db` — the family's one
 * unscoped package — so `changeset version`'s pre-1.0 heuristic bumped it and
 * nothing pulled it back onto the line. It drifted to `0.3.x` while the line
 * moved to `0.7.x`, and because its wizard fills every template pin from its
 * OWN version (#703), every scaffolded app pinned `^0.3.4` — a range no
 * published hub has ever satisfied. The mechanism built to keep pins on the
 * line was the mechanism keeping them off it, and no gate observed it.
 *
 * Third instance of the same class in one day (release.mjs, the release
 * workflow's publish path — #1233 — and the family-local registry's scope
 * rules): a rule written in a scope shape that one real member does not have.
 * So the rule here names what it actually means. `private` packages are
 * excluded because they are never published and so have no version on the
 * line to keep; `typescript-config` is filtered by DIRECTORY in release.mjs
 * (documented there) and would also fall out here for being private.
 *
 * ⚠️ Do not re-introduce a name test "for safety". A package in `packages/`
 * that should not ride the line must say so with `"private": true`, which is
 * a statement the publish path also honours; a name filter is one only this
 * script reads.
 */
export function isLockstepMember(pkg) {
  return typeof pkg?.name === 'string' && pkg.name.length > 0 && pkg.private !== true
}
