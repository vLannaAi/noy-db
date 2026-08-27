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
