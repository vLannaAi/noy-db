# @noy-db/memory

> In-memory adapter for [noy-db](https://github.com/vLannaAi/noy-db) — ideal for testing and ephemeral workloads.

[![npm](https://img.shields.io/npm/v/@noy-db/memory.svg)](https://www.npmjs.com/package/@noy-db/memory)

## Install

```bash
pnpm add @noy-db/core @noy-db/memory
```

## Usage

```ts
import { createNoydb } from '@noy-db/core'
import { memory } from '@noy-db/memory'

const db = await createNoydb({
  adapter: memory(),
  userId: 'alice',
  passphrase: 'correct horse battery staple',
})
```

Data lives only in the current process — it's gone when the process exits. Perfect for:

- Unit and integration tests
- Short-lived scripts
- Benchmarks
- Prototyping before wiring up persistent storage

## License

MIT © vLannaAi — see the [noy-db repo](https://github.com/vLannaAi/noy-db) for full documentation.
