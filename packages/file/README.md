# @noy-db/file

> JSON file adapter for [noy-db](https://github.com/vLannaAi/noy-db) — encrypted document store on local disk, USB sticks, or network drives.

[![npm](https://img.shields.io/npm/v/@noy-db/file.svg)](https://www.npmjs.com/package/@noy-db/file)

## Install

```bash
pnpm add @noy-db/core @noy-db/file
```

## Usage

```ts
import { createNoydb } from '@noy-db/core'
import { file } from '@noy-db/file'

const db = await createNoydb({
  adapter: file({ dir: '/Volumes/USB/firm-data' }),
  userId: 'alice',
  passphrase: process.env.NOYDB_PASSPHRASE!,
})
```

Each compartment is written as a set of JSON files containing only ciphertext envelopes — the adapter never sees plaintext. Perfect for:

- USB-stick workflows (air-gapped data portability)
- Local-first desktop apps
- Network drive sharing with per-user passphrases
- Backup-friendly storage

## License

MIT © vLannaAi — see the [noy-db repo](https://github.com/vLannaAi/noy-db) for full documentation.
