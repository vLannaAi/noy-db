# @noy-db/test-format-conformance

The `as-*` export gate, published as an executable suite.

```ts
import { runFormatConformanceTests } from '@noy-db/test-format-conformance'

runFormatConformanceTests('as-myformat', {
  format: 'myformat',
  vault: () => seededExportCapableVault(),
  exports: [
    { name: 'toString', run: (v) => toString(v, opts) },
    { name: 'download', run: (v) => download(v, opts) },
    { name: 'write',    run: (v) => write(v, path, { ...opts, acknowledgeRisks: true }) },
  ],
  writeWithoutAcknowledgement: (v, path) => write(v, path, opts),
})
```

## What it checks

`as-*` is the one place plaintext leaves the vault. Every package calls
`vault.assertCanExport('plaintext', <format>)`, and that call is the whole
boundary. Nine packages had converged on the same shape by convention, and
convention is what the next format author reads instead of a contract.

For **every** entry point the fixture lists:

- it **refuses** when `assertCanExport` denies, and
- it refuses **before reading a single record**.

Plus: the `write` path refuses without `acknowledgeRisks: true`.

## Gated is not the property. Gated BEFORE decrypting is.

A gate called after `exportStream` has run refuses the caller *and decrypts
anyway*. That is the property a delegation refactor breaks silently — move the
gate from `toObject` into `download` and every existing test still passes.

Proven, not asserted: moving as-csv's gate inside its `exportStream` loop
leaves both "REFUSES" cases green and fails all three "before reading" cases.

## The two ways this suite could have been vacuous

Both were real, and both were found by trying to break it rather than by
reading it.

**A refusal is only evidence when the same call would otherwise succeed.**
The kit's first case runs an entry point on the *ungated* vault and requires it
to resolve. On its first run it failed `as-zip` — whose export path opens a
blob slot, so the fixture vault was refusing on *blob storage*, not on the
export gate. **Six green cases in a file I had just declared passing were
passing for the wrong reason.**

**`rejects.toThrow()` is absorbed by whichever guard fires first.** The
acknowledgement case originally used a vault with no `exportCapability` grant,
so `write` refused at the export gate and never reached the flag — deleting the
acknowledgement guard from as-csv left the suite green. Fixed twice over: the
case now matches on `/acknowledgeRisks/`, and the fixture is required to supply
an export-capable vault.

## Why a Proxy and not a fake Vault

A hand-written double would drift from `Vault`, and would only ever exercise
the methods whoever wrote it thought of. The fixture supplies a **real** vault
and the kit wraps it, so an entry point reaching for some other decrypting
method is still observed.

## Mutation-checked

| mutation | result |
|---|---|
| as-csv: gate deleted | 6 fail |
| as-csv: gate moved after the read | 3 fail — the "before reading" cases only |
| as-csv: `acknowledgeRisks` guard deleted | 1 fails |
| as-zip: gate deleted | 6 fail |

## All nine formats bind it

`as-blob` · `as-csv` · `as-json` · `as-ndjson` · `as-noydb` · `as-sql` ·
`as-xlsx` · `as-xml` · `as-zip`.

Wiring them found that the family is **two capability tiers**, not one:

| tier | packages | gate |
|---|---|---|
| `plaintext` | eight | `assertCanExport('plaintext', <format>)` |
| `bundle` | `as-noydb` | `assertCanExport('bundle')` — no format |

`as-noydb` emits an **encrypted** pod, so it also has **no `acknowledgeRisks`
gate**, and its source says so twice. Its fixture therefore declares no
acknowledgement case — and the suite prints
`write: SKIPPED — … UNVERIFIED here` rather than staying quiet, which is the
difference between a documented absence and a hole.

`as-aws-s3` is not in the list: it exports `asAwsS3(options)` and is a
**destination, not a format**.

## The vacuity guard earned its place twice

It fired on `as-zip` (no `withBlobs()`) and on `as-blob` (no blob attached to
the seeded record). In both cases six refusal assertions were green and
meaningless. Neither would have been visible from reading the output.
