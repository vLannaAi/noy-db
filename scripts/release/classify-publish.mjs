/**
 * Classify an `npm publish` outcome for a package on its OWN version line (#1233).
 *
 * `create-noy-db` is skipped by the lockstep normalizer and only moves when
 * `changeset version` bumps it as a dependent. A satellite-only release — which
 * became possible with #1230 — does not bump it at all, so the publish step
 * tries to republish an already-published version and npm refuses with E403.
 * Nothing needed publishing, but the job exits 1 and every later step is
 * SKIPPED, including the docs-bridge payload. The red tick is cosmetic; the
 * skipped step is the damage.
 *
 * ⚠️ The discrimination is deliberately NARROW, and widening it would be a
 * security-shaped mistake:
 *
 *   - npm reports write-path AUTH failures as **404, never 401**. "is not in
 *     this registry" almost always means an expired token or wrong account,
 *     and that must fail loudly.
 *   - a genuine permissions **E403** ("you do not have permission to publish")
 *     must also fail loudly.
 *
 * So this matches the "cannot publish over the previously published versions"
 * condition specifically, not E403 in general. Anything unrecognised fails —
 * the default is to fail, not to tolerate.
 *
 * @param {number} exitCode  npm publish's exit code
 * @param {string} log       its combined stdout+stderr
 * @returns {'ok'|'already-published'|'failed'}
 */
export function classifyPublishFailure(exitCode, log) {
  if (exitCode === 0) return 'ok'
  const text = String(log ?? '')
  // The exact npm phrasing. Anchored on the sentence rather than the code, so
  // a permissions E403 — same code, different meaning — is not swept up.
  if (/cannot publish over the previously published version/i.test(text)) {
    return 'already-published'
  }
  return 'failed'
}

/**
 * `peerDependenciesMeta` entries with no matching `peerDependencies` entry.
 *
 * The meta block only ANNOTATES a peer that already exists — it cannot declare
 * one. An orphaned entry is inert: npm never learns about the package, the
 * consumer gets no version range and no resolver signal, and nothing warns.
 * The manifest meanwhile reads as though the dependency were declared and
 * deliberately optional, which is why this survives review.
 *
 * `@noy-db/in-rest` shipped this way: express / fastify / hono / h3 marked
 * optional, only `@noy-db/hub` actually declared, and three of the four
 * genuinely imported from adapter entry points.
 *
 * Asserted on the OUTPUT condition — no meta entry may lack a peer — rather
 * than on the four names that happened to be found.
 *
 * @param {{peerDependencies?: Record<string,string>, peerDependenciesMeta?: Record<string,unknown>}} pkg
 * @returns {string[]} orphaned names, empty when the manifest is consistent
 */
export function orphanPeerMeta(pkg) {
  const peers = new Set(Object.keys(pkg?.peerDependencies ?? {}))
  return Object.keys(pkg?.peerDependenciesMeta ?? {}).filter((n) => !peers.has(n))
}
