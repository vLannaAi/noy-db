/**
 * #1230 — the guard that makes `release:version` refuse a no-op release.
 *
 * `release.mjs` derives the canonical lockstep version from `@noy-db/hub`
 * AFTER `changeset version` has run, then normalizes every package to it.
 * That assumes every release contains at least one hub changeset. When it
 * does not — a satellite-only release, e.g. an `@noy-db/in-rest` fix — hub
 * never bumps, the canonical version is hub's UNCHANGED and already-published
 * version, and the normalizer drags the legitimately-bumped satellite back
 * down to it. The run exits 0, prints a tidy uniform summary, consumes the
 * changesets, and leaves nothing to publish.
 *
 * The assertion is on the OUTPUT the script exists to produce — the canonical
 * version advanced — not on the input that happened to expose it. A future
 * cause with the same outcome fails here too.
 */

/** Compare two dot/dash-separated versions segment-wise; numeric where both are numeric. */
function isAfter(a, b) {
  const seg = v => String(v).split(/[.-]/).map(s => (/^\d+$/.test(s) ? Number(s) : s))
  const [x, y] = [seg(a), seg(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i], r = y[i]
    if (l === r) continue
    // One side ran out of segments, so the other carries a prerelease tail.
    // In semver the SHORTER version is the later release: 0.7.0 > 0.7.0-pre.1.
    // Unreachable within a pre line (equal segment counts), so this boundary
    // was first exercised by the 0.7.0 stable cut.
    if (l === undefined) return true         // a is the stable, b has the tail → a is later
    if (r === undefined) return false        // b is the stable, a has the tail → a is earlier
    if (typeof l === 'number' && typeof r === 'number') return l > r
    return String(l) > String(r)
  }
  return false
}

/**
 * Throws unless `after` is strictly later than `before`.
 * @param {string} before canonical version BEFORE `changeset version`
 * @param {string} after  canonical version AFTER it
 */
export function assertCanonicalAdvanced(before, after) {
  const valid = v => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)
  if (!valid(before)) {
    throw new Error(
      `[release] could not read the canonical version BEFORE changeset version (got ${String(before)}). ` +
      `Refusing to continue: without a baseline this guard cannot tell a real release from a no-op.`,
    )
  }
  if (!valid(after)) {
    throw new Error(`[release] could not read the canonical version AFTER changeset version (got ${String(after)}).`)
  }
  if (!isAfter(after, before)) {
    throw new Error(
      `[release] the canonical version DID NOT ADVANCE: still ${after} (was ${before}).\n` +
      `  That version is already released, so this run would consume the pending changesets and\n` +
      `  publish nothing. The usual cause is that NO pending changeset targets @noy-db/hub — the\n` +
      `  canonical version is read from hub, so a satellite-only release leaves it unchanged and\n` +
      `  every satellite is then normalized back down to it (#1230).\n` +
      `  Nothing has been published. Restore .changeset/pre.json (it is gitignored, so git will\n` +
      `  NOT restore it) and revert any CHANGELOG.md edits before retrying.`,
    )
  }
}

/**
 * The next version of the lockstep LINE (#1230).
 *
 * A release moves every package to one version, so a release with no hub
 * changeset is still a line move — the line has to advance or the release is
 * impossible. `changeset version` cannot do this on its own: it bumps only
 * packages a changeset names, and this repo overrides its output anyway.
 *
 * Deliberately narrow. Advancing a PRERELEASE counter is arithmetic and safe.
 * Advancing a STABLE version is not — patch versus minor is a judgement about
 * what changed, and guessing would silently pick a semantic nobody chose. That
 * case throws and asks for an explicit hub changeset instead.
 *
 * @param {string} current the current canonical version
 * @returns {string} the next version on the same line
 */
export function nextLineVersion(current) {
  if (typeof current !== 'string' || !/^\d+\.\d+\.\d+/.test(current)) {
    throw new Error(`[release] cannot advance an unreadable version: ${String(current)}`)
  }
  const m = /^(\d+\.\d+\.\d+)-([0-9A-Za-z-]+)\.(\d+)$/.exec(current)
  if (!m) {
    if (/^\d+\.\d+\.\d+$/.test(current)) {
      throw new Error(
        `[release] ${current} is a STABLE version and this run has no hub changeset, so the line ` +
        `cannot be advanced automatically — patch versus minor is a judgement about what changed, ` +
        `not arithmetic. Add a changeset for @noy-db/hub describing the release and re-run (#1230).`,
      )
    }
    throw new Error(`[release] unrecognised version shape, cannot advance safely: ${current}`)
  }
  return `${m[1]}-${m[2]}.${Number(m[3]) + 1}`
}

/**
 * Did `changeset version` write a new CHANGELOG section for this package?
 *
 * The heading rewriter maps `## <before>` to `## <after>`, which is sound only
 * when `before` names a section changesets JUST WROTE. A package with no
 * changeset is not moved by `changeset version`, so its topmost heading is the
 * PREVIOUSLY PUBLISHED one — rewriting it renames released history. That is not
 * hypothetical: advancing the line for a satellite-only release turned hub's
 * `## 0.7.0-pre.6` into `## 0.7.0-pre.7` while pre.6 was already on npm (#1230).
 *
 * @param {string} beforeChangesets version before `changeset version` ran
 * @param {string} afterChangesets  version after it ran, before normalization
 */
export function changesetWroteASection(beforeChangesets, afterChangesets) {
  return beforeChangesets !== afterChangesets
}
