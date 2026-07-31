/**
 * Extract the verbatim markdown body of a CHANGELOG's `## <version>` section.
 * Returns null when the version has no section (a version-only release for
 * that package). Matching is exact — `0.4.0` must not match `0.4.0-pre.11`.
 *
 * Kept byte-identical to noy-db-to's copy (scripts/docs-bridge/changelog.mjs)
 * so both producers extract the same text for the same CHANGELOG. Small enough
 * that duplicating it beats minting a shared package across two repos.
 */
export function extractSection(changelogText, version) {
  const lines = changelogText.split('\n')
  const start = lines.findIndex(l => l.trim() === `## ${version}`)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break }
  }
  return lines.slice(start + 1, end).join('\n').trim() || null
}
