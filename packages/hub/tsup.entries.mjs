// Single source of truth for the hub's tsup entry map (#660).
//
// Shared by tsup.config.ts (the JS build — one invocation, all entries,
// `splitting: true` for cross-subpath class identity) and
// scripts/build.mjs (the single plain `tsc --emitDeclarationOnly` declaration
// pass — see that file for why it replaced tsup's rollup-dts bundling).
export const ENTRIES = {
  index: 'src/index.ts',
  'i18n/index': 'src/via/i18n/index.ts',
  'team/index': 'src/with-party/team/index.ts',
  'broker/index': 'src/with-party/broker/index.ts',
  'session/index': 'src/with-party/session/index.ts',
  'history/index': 'src/with-commit/history/index.ts',
  'vault-head/index': 'src/with-commit/vault-head/index.ts',
  'forget/index': 'src/with-audit/forget/index.ts',
  'sealed-record/index': 'src/with-audit/sealed-record/index.ts',
  'query/index': 'src/kernel/query/index.ts',
  // #1458 — the three query-tier extensions. Each is a SIDE-EFFECT entry
  // (it patches Query.prototype on load) and each is named in package.json's
  // `sideEffects` array; see `src/kernel/query/relate/index.ts`.
  'query/live/index': 'src/kernel/query/live/index.ts',
  'query/reduce/index': 'src/kernel/query/reduce/index.ts',
  'query/relate/index': 'src/kernel/query/relate/index.ts',
  // `query/all` — Find plus all three groups, and the module the ROOT BARREL
  // takes `Query` from. It is an entry for a build-shape reason as much as a
  // published one: an entry that another entry also imports becomes a SHARED
  // CHUNK, which is what keeps the install calls droppable-with-Query instead
  // of inlined into `dist/index.js` unconditionally. See src/kernel/query/all.ts.
  'query/all/index': 'src/kernel/query/all.ts',
  'debug/index': 'src/kernel/debug.ts',
  'blobs/index': 'src/via/blob/index.ts',
  'indexing/index': 'src/with-lookup/indexing/index.ts',
  'lazy/index': 'src/with-store/lazy/index.ts',
  'reduce/index': 'src/with-lookup/reduce/index.ts',
  'crdt/index': 'src/with-commit/crdt/index.ts',
  'pod/index': 'src/with-pod/index.ts',
  'consent/index': 'src/with-audit/consent/index.ts',
  'coverage/index': 'src/with-audit/coverage/index.ts',
  'periods/index': 'src/with-audit/periods/index.ts',
  'guards/index': 'src/with-audit/guards/index.ts',
  'shadow/index': 'src/with-fork/shadow/index.ts',
  'snapshots/index': 'src/with-fork/snapshots/index.ts',
  'transactions/index': 'src/with-commit/tx/index.ts',
  'search/index': 'src/with-lookup/search/index.ts',
  'sequence/index': 'src/with-commit/sequence/index.ts',
  'custody/index': 'src/with-party/custody/index.ts',
  'derivations/index': 'src/with-formula/derivations/index.ts',
  'materialized-views/index': 'src/with-formula/materialized-views/index.ts',
  'overlay-views/index': 'src/with-formula/overlay-views/index.ts',
  'sync/index': 'src/with-sync/index.ts',
  'util/index': 'src/kernel/util/index.ts',
  'share-link/index': 'src/share-link/index.ts',
  'attestation/index': 'src/with-audit/attestation/index.ts',
  'classified/index': 'src/via/classified/index.ts',
  'satellites/index': 'src/with-shape/satellites/index.ts',
  'tiers/index': 'src/with-audit/tiers/index.ts',
  'portability/index': 'src/with-audit/portability/index.ts',
  'cargo/index': 'src/with-cargo/index.ts',
  'to/index': 'src/port/to/index.ts',
  'as/index': 'src/port/as/index.ts',
  'on/index': 'src/port/on/index.ts',
  'at/index': 'src/port/at/index.ts',
  'by/index': 'src/port/by/index.ts',
  'store/index': 'src/with-store/index.ts',
  'introspection/index': 'src/with-shape/introspection/index.ts',
  'money/index': 'src/via/money/index.ts',
  'cover/index': 'src/with-party/directory/cover/index.ts',
  'schema-update/index': 'src/with-shape/schema-update/index.ts',
  'policy/index': 'src/with-party/policy/index.ts',
  'directory/index': 'src/with-party/directory/index.ts',
}
