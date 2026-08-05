# Deferred: storage projection, debug mode, and schema tooling

Open questions with no owner. Each was raised during a design pass, left
unanswered because nothing depended on the answer, and will be asked again by
whoever next touches the area.

---

## Object projection (`as-aws-s3` direct-serve)

Projecting blobs to a bucket so they can be served directly is the one place
where the project deliberately writes readable bytes to a third-party backend.
The unresolved questions are all about how much that decision leaks:

- **Key naming.** Stable public keys, or unguessable random-suffix keys even for
  explicitly public objects? Unguessable keys are defence-in-depth for the
  "public but unlisted" case, at the cost of a lookup.
- **Presigned TTL.** Should `publicUrl()` auto-rotate presigned URLs, and should
  the default TTL be configurable per field?
- **Integrity signal.** Store the encrypted twin's eTag as object metadata so a
  public object can be validated against the vault? Without it, a projected
  object and its vault record can silently diverge.
- **Push-metadata allowlist.** Which record fields may be mirrored into
  *unencrypted* S3 user metadata? This needs explicit per-field opt-in given the
  plaintext exposure — defaulting it open would be a quiet hole.
- **Cross-cloud shape.** Is the abstraction `as-aws-s3`-specific, or should a
  generic `ObjectProjection` be defined now so R2 and GCS can follow?

Import direction (bucket → collection) has its own unanswered pair: how folders
map to collections (one per top-level prefix, flat, or a user-supplied mapping),
how ids are derived (sanitized object key vs content hash), and whether the
bootstrap ships as a CLI, a vault-level API, or both.

---

## Plaintext / debug store mode

An `encrypt: false` mode already exists and threads through the write path, so
the raw capability is there. What was never decided is whether to make it a
**first-class, clearly-fenced debug mode** rather than a flag:

- **Reserved-prefix collisions.** If a user field collides with an internal
  reserved prefix in the legible output — reject on write, or auto-escape?
- **Internal collection shape.** Should debug mode also render the internal
  dictionary and blob-index collections into a more legible form, or leave
  internals as they are? Legibility helps debugging; it also teaches people to
  depend on internal shapes.
- **A read-only inspect variant.** Decrypt-on-the-fly into a plaintext mirror,
  for vaults that must stay encrypted at rest but need a momentary readable
  view. This is arguably the more useful feature and the more dangerous one.

The framing that matters: this is the one mode where the project's central
guarantee is off on purpose. Whatever ships must be impossible to enable by
accident and obvious in every surface that reports vault state.

---

## Schema tooling

Deferred extensions to the schema dump / describe surface:

- **Converters beyond Zod** — Valibot, ArkType, Effect Schema. Each needs its
  own JSON Schema derivation. Zod covers the large majority; the others emit
  stub envelopes that flag themselves.
- **Schema diff** (`describe` against a file). Useful, and purely additive on
  top of the existing emitter.
- **Round-trip scaffolding and TypeScript codegen.** Both were judged migration-
  tool territory rather than audit-tool territory. Codegen in particular needs
  the validator surface to round-trip, which it does not.
- **Visual emit** — Mermaid, dbml, drawio.

Two smaller open points from the same pass: whether a stub `_schemas` entry
should exist for collections that did not opt in (so absence is distinguishable
from non-participation), and the O(n) cost of `--with-stats` on very large
vaults.

---

## Sealed numbering

The deterministic-numbering design left four questions open, all of which matter
if the feature is ever extended past its current shape:

- **Where the seal runs** — any operator running the deterministic seal under
  CAS arbitration, or a single designated sealer. Any-operator was recommended;
  a designated sealer is simpler but needs that node online.
- **Uncertainty-bound sourcing** — fixed conservative constant, NTP-reported
  dispersion, or observed round-trip. A conservative constant was the
  recommended start.
- **Settling window versus latency** — the window trades issue latency for
  safety, and the right value is workload-specific.
- **Date-order versus sync-order for offline writers.** Late-synced numbers
  arrive in sync order, which can break "numbers ascend with dates". The choice
  is between flagging late arrivals for manual handling and accepting the
  reordering. For anything fiscal this is a correctness question, not a
  preference.
