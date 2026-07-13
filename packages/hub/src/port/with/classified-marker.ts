/**
 * C-A/R10 config-drift marker store I/O — re-exported here (not
 * `via/classified/config-drift.js` directly) so `Collection`'s
 * dynamic `import()` in `_ensureClassifiedMarker`/`_classifiedMarkerDigestOnly`
 * stays lazy while satisfying via-layering (#629 Task 6: the kernel spine
 * may not name a `via/classified/*` path, not even inside a dynamic
 * import specifier).
 */
export { persistClassifiedMarkerForFields, readClassifiedMarkerDigestOnly } from '../../via/classified/config-drift.js'
