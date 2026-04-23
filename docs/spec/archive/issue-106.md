# Issue #106 — feat(core): naked mode — opt-in plaintext storage for debugging (dev-only, heavy guardrails)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature, type: security, priority: low, area: core

---

## Summary

Add an **opt-in, development-only "naked mode"** where the crypto layer is bypassed and records are stored in plaintext. This exists **purely for debugging** — inspecting what a query actually stored, diffing records with standard tools, tailing a file adapter with `tail -f`, running `jq` against a dump — situations where fighting the encryption layer makes debugging harder than it needs to be.

**This is a loaded footgun.** The issue is as much about the guardrails as the feature itself. Done wrong, it's a one-flag path to committing plaintext client data to Drive/S3/git. Done right, it's a scoped debug convenience that cannot accidentally escape a dev machine.

## Motivation

During development and CI debugging we've repeatedly hit cases where:

- A test fails and the only useful artifact is a directory full of encrypted envelopes.
- A query returns unexpected results and we want to `grep` the on-disk state.
- Tooling outside noy-db (jq, ripgrep, editor plugins, GUI diff tools) can't see into envelopes.
- Reproducing a consumer bug report requires inspecting the raw storage layout without a session.

Every one of these is currently solved by manually decrypting, inspecting, re-encrypting — or by writing one-off scripts. A sanctioned "just store it clear while I figure this out" mode would be faster and less error-prone than the workarounds, *provided* it cannot leak.

## Proposed design

### Opt-in at instance creation, not at collection or record level

```ts
const db = await createNoydb({
  auth: { userId: 'dev', passphrase: 'dev' },
  adapter: memory(),
  naked: {
    enabled: true,
    acknowledge: 'I-UNDERSTAND-THIS-DISABLES-ALL-ENCRYPTION',
    reason: 'debugging issue #nnn',
  },
})
```

The `acknowledge` string is a **literal constant**. It is not a boolean, not a config value from env, not a variable. Grep-discoverable in any codebase that enables it. Code review will catch it on sight. A developer who wants naked mode has to consciously type out a sentence confessing what they're doing — that's the point.

The `reason` string is logged to stderr and persisted into every record so the field is still there if a dev leaves naked mode on by accident and commits the data somewhere.

### Hard-blocked by environment checks

Naked mode **refuses to initialize** if any of these are true:

1. `process.env.NODE_ENV === 'production'` (Node) — hard throw.
2. `import.meta.env.PROD === true` (Vite/Nuxt) — hard throw.
3. Running in a browser on a non-localhost origin (`window.location.hostname` not in `['localhost', '127.0.0.1', '::1']`) — hard throw.
4. A CI environment variable is set **without** a corresponding `NOYDB_NAKED_ALLOW_IN_CI=1` escape hatch — hard throw.
5. The selected adapter is `@noy-db/drive`, `@noy-db/s3`, or `@noy-db/dynamo` — hard throw regardless of other checks. Remote adapters cannot be combined with naked mode, full stop. Only `memory` and `file` are allowed, and `file` only under a configured debug directory prefix (see below).

Each block throws a distinct error type so tests can assert on them:

- `NakedModeProductionError`
- `NakedModeRemoteAdapterError`
- `NakedModeCiWithoutOptInError`
- `NakedModeMissingAcknowledgmentError`

### On-disk discriminator

Plaintext records written by naked mode carry a **different envelope shape** from encrypted records, and the shape is deliberately incompatible:

```json
{
  "_noydb_naked": 1,
  "_v": 3,
  "_ts": "2026-04-08T10:00:00.000Z",
  "_warning": "PLAINTEXT DEV MODE — NOT FOR PRODUCTION",
  "_reason": "debugging issue #nnn",
  "_data": { ...record fields... }
}
```

Consequences:

- A naked-mode file **will not load** in a normally-configured instance. Core's envelope parser recognizes `_noydb_naked` and refuses to decrypt — throws `NakedEnvelopeRejectedError` unless the receiving instance is itself in naked mode. This stops the "I debugged locally and accidentally shipped the dev file to prod" case cold.
- The `_warning` field is on every single record. Any tool that grep-scans the directory will trip on the warning string immediately.
- Envelopes produced by naked mode **cannot be round-tripped** into a real compartment. Moving data between naked and encrypted mode requires an explicit `noydb migrate --from-naked` CLI command that re-encrypts every record with a fresh DEK and strips the `_noydb_naked` marker. Never implicit.

### File adapter: scoped to a debug directory prefix

When naked mode is combined with `@noy-db/file`, the adapter refuses unless the `dir` path contains a debug-directory segment (`node_modules/.cache`, `/tmp`, `.noydb-debug`, or an explicitly allowlisted prefix via `NOYDB_NAKED_ALLOWED_DIRS`). This prevents the "I set `dir: './data'` and ran naked mode" case — the default project-root data directory is blocked by construction.

### Loud runtime signals

Every session in naked mode emits:

- `console.warn('⚠️  NOYDB NAKED MODE — encryption disabled')` on `createNoydb()` and on every compartment open. Uncatchable, unsuppressable.
- A lifecycle event `naked:active` on every collection operation — so a Vue/Nuxt devtools panel can render a persistent red banner while naked mode is live.
- A header field on every dumped bundle: `dump()` refuses in naked mode unless passed `{ allowNaked: true }`, and the resulting bundle carries `_naked: true` in the container header (where `inspect` will display it prominently).

### CLI integration

```bash
# Open a naked-mode directory, refuses if the path isn't in a debug prefix
noydb open --naked /tmp/noydb-debug/

# Convert a naked dump to a real encrypted compartment
noydb migrate --from-naked /tmp/noydb-debug/ --to ./data/ --passphrase-from-stdin

# Refuses — cannot go the other direction without explicit re-expose
noydb migrate --to-naked ./data/ --to /tmp/noydb-debug/
# Error: naked mode cannot ingest encrypted data. Use `dump | load --naked` explicitly.
```

## What naked mode does NOT change

- **Keyring shape and permission checks** still run normally. Naked mode disables *crypto*, not *access control*. An operator user still can't read a collection they don't have permission for. This matters: if naked mode also bypassed ACL, nobody would trust it to reproduce bugs that involve permission logic.
- **Ledger chain** still runs normally. `compartment.dump()` still produces a ledger head, `verifyBackupIntegrity()` still works — with the understanding that the integrity is over plaintext envelopes, not ciphertext.
- **Schema validation** still runs normally.
- **Query DSL** behaves identically.

The goal is that every code path *except* encrypt/decrypt behaves the same as a real session, so debugging naked-mode sessions is informative about encrypted sessions.

## Security review checklist (must pass before merging)

- [ ] Every path that could enable naked mode has a test asserting the production/remote/ci guards throw.
- [ ] A grep for `naked` in the published bundle has zero hits in the production build (tree-shaken out via `process.env.NODE_ENV` dead-code elimination). CI-asserted.
- [ ] The `_warning` field is written on every record write path (put, putMany, bulk load, migrate).
- [ ] `NakedEnvelopeRejectedError` is covered by the existing security test suite alongside wrong-key and tamper-detection tests.
- [ ] The `file` adapter's debug-directory prefix check is covered by tests with both allowed and disallowed paths.
- [ ] Documentation page carries a prominent danger banner and explicitly tells consumers never to use naked mode against real data directories.
- [ ] Changelog entry flags this as a development feature, not a production feature.

## Out of scope

- A "partial naked" mode that only decrypts specific collections. Too many sharp edges; all-or-nothing is safer.
- Naked mode as a runtime toggle on an existing instance. Instance is born naked or it isn't — no flipping.
- Naked mode for the browser adapter's IndexedDB backend. Debugging via browser devtools can already read IndexedDB — if you need plaintext there, use the memory adapter in naked mode instead.
- Read-only naked mode on an encrypted compartment ("just show me the plaintext for a minute"). That's `dump()` + `jq`, not a new mode.

## Open questions

1. Should naked mode require a **non-production build flag** at the bundler level, so production builds literally cannot import the naked-mode code? More invasive but eliminates the "runtime guard was bypassed" threat model entirely.
2. Should the `_reason` field be mandatory, with a minimum length check? Leaning yes — forces the developer to write down what they're doing, which creates a paper trail if the file ends up somewhere it shouldn't.
3. Should `noydb inspect` on a naked bundle display the reason + the warning prominently, before showing anything else? Yes, probably.
4. What's the right behavior for `sync: ...` when naked mode is active? Current proposal: hard throw on any remote adapter. Alternative: allow `memory` sync for multi-instance debugging. Leaning strict.

## Why this is a security issue despite being a debug feature

The threat model for noy-db is "adapters are untrusted, crypto is the trust boundary." Naked mode removes the trust boundary. Every single one of the guardrails above exists to make the *absence* of the trust boundary discoverable, auditable, and geographically confined to a dev machine. If any guardrail can be silently bypassed, naked mode is a CVE waiting to happen, not a debug convenience.

This is why it's filed as a feature issue with `type: security` on it, not just `enhancement`. Whoever picks it up should treat the guardrails as the hard requirement and the feature as the side effect.
