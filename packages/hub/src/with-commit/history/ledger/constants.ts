/**
 * Ledger storage constants — pinned in their own leaf module so
 * always-on core code (vault.ts, dictionary.ts) can import them
 * without dragging the `LedgerStore` class into the bundle.
 *
 * `splitting: true` in tsup is not enough on its own: when a
 * source file exports both pure constants and a heavyweight class,
 * the bundler keeps the entire chunk reachable from any importer.
 * Extracting the constants lets the floor scenario import them
 * without paying for the class.
 *
 * @internal
 */

/** The internal collection name used for ledger entry storage. */
export const LEDGER_COLLECTION = '_ledger'

/**
 * The internal collection name used for delta payload storage.
 *
 * Deltas live in a sibling collection (not inside `_ledger`) for two
 * reasons:
 *
 *   1. **Listing efficiency.** `ledger.loadAllEntries()` calls
 *      `adapter.list(_ledger)` which would otherwise return every
 *      delta key alongside every entry key. Splitting them keeps the
 *      list small (one key per ledger entry) and the delta reads
 *      keyed by the entry's index.
 *
 *   2. **Prune-friendliness.** A future `pruneHistory()` will delete
 *      old deltas while keeping the ledger chain intact (folding old
 *      deltas into a base snapshot). Separating the storage makes
 *      that deletion a targeted operation on one collection instead
 *      of a filter across a mixed list.
 *
 * Both collections share the same ledger DEK — one DEK, two
 * internal collections, same zero-knowledge guarantees.
 */
export const LEDGER_DELTAS_COLLECTION = '_ledger_deltas'
