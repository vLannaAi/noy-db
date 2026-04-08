# @noy-db/file

## 0.5.0

### Initial release

JSON file adapter for `@noy-db/core` — maps the noy-db hierarchy to the filesystem:

```
{dir}/{compartment}/{collection}/{id}.json
{dir}/{compartment}/_keyring/{userId}.json
{dir}/{compartment}/_ledger/{index}.json
```

Intended for USB stick workflows, local disk, network drives, or any filesystem-based deployment. Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability and the optional `listCompartments` cross-compartment enumeration capability (reads the base directory and returns every entry that is itself a directory, skipping top-level files like README, .DS_Store, .git). Uses `node:fs/promises` for all I/O — Node 18+ only. Version conflict detection via `expectedVersion` on `put` throws `ConflictError`. Missing directories are created on demand.

Zero runtime dependencies beyond `node:fs`.
