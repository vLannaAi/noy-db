---
"@noy-db/pinia": minor
---

Add `createNoydbPiniaPlugin` — the augmentation path for existing Pinia stores.

Existing apps with `defineStore()` calls can opt into NOYDB persistence by adding a single `noydb:` option, with no component code changes:

```ts
import { createPinia } from 'pinia';
import { createNoydbPiniaPlugin } from '@noy-db/pinia';
import { jsonFile } from '@noy-db/file';

const pinia = createPinia();
pinia.use(createNoydbPiniaPlugin({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: () => promptPassphrase(),
}));

// existing store — add one option:
export const useClients = defineStore('clients', {
  state: () => ({ list: [] as Client[] }),
  noydb: { compartment: 'C101', collection: 'clients', persist: 'list' },
});
```

Features:

- `persist: 'key' | ['k1', 'k2'] | '*'` selects which state keys to mirror
- Store gets `$noydbReady`, `$noydbError`, `$noydbAugmented`, `$noydbFlush()` fields
- Lazy Noydb instantiation — apps with no augmented stores pay zero crypto cost
- Optional Standard-Schema validator at the document level
- Pinia module augmentation so `noydb:` autocompletes inside `defineStore()`

Closes #11.
