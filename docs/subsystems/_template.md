# <Subsystem Name>

> **Subpath:** `@noy-db/hub/<name>`
> **Factory:** `with<Name>()`
> **Cluster:** <A–G>
> **LOC cost:** ~<n> (off-bundle when not opted in)

## What it does

One paragraph. The feature, in plain language.

## When you need it

Three to five bullet scenarios. Concrete, not abstract.

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { with<Name> } from '@noy-db/hub/<name>'

const db = await createNoydb({
  store: ...,
  user: ...,
  <name>Strategy: with<Name>(),
})
```

## API

The public surface this subsystem adds: methods on `Vault`, `Collection`, query terminals, top-level helpers.

## Behavior when NOT opted in

- What surfaces are still callable (no-ops vs throws)
- What error message guides the developer to the subpath import

## Pairs well with

Cross-references to other subsystems that compose naturally.

## Edge cases & limits

Row ceilings, performance considerations, security notes.

## See also

Related SPEC sections, ADRs, showcase tests.
