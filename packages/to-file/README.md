# @noy-db/to-file

> JSON file adapter for [noy-db](https://github.com/vLannaAi/noy-db) — encrypted document store on local disk, USB sticks, or network drives.

[![npm](https://img.shields.io/npm/v/@noy-db/to-file.svg)](https://www.npmjs.com/package/@noy-db/to-file)

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-file
```

## Usage

```ts
import { createNoydb } from '@noy-db/hub'
import { file } from '@noy-db/to-file'

const db = await createNoydb({
  adapter: file({ dir: '/Volumes/USB/firm-data' }),
  userId: 'alice',
  secret: process.env.NOYDB_SECRET!,
})
```

Each compartment is written as a set of JSON files containing only ciphertext envelopes — the adapter never sees plaintext. Perfect for:

- USB-stick workflows (air-gapped data portability)
- Local-first desktop apps
- Network drive sharing with per-user secrets
- Backup-friendly storage

Record writes are staged in a `.tmp` sidecar and renamed into place, so an interrupted write — Wi-Fi dropping mid-write to a mounted share, a USB stick pulled during a flush — never leaves a truncated file under a record's name. Readers see the complete previous file or the complete new one.

## License

MIT © vLannaAi — see the [noy-db repo](https://github.com/vLannaAi/noy-db) for full documentation.
