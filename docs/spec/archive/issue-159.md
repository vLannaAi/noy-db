# Issue #159 — feat(scaffolder): wizard — multi-backend setup (primary + sync targets)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-22
- **Milestone:** v0.17.1 Good to have scaffolding
- **Labels:** type: feature, area: scaffolder

---

Extends the `create-noy-db` setup wizard to configure a multi-backend topology from the start.

Depends on the core `SyncTarget[]` API from #158.

## Current wizard

The wizard asks: pick a primary store → done. There is no prompt for secondary stores.

## What this adds

After selecting a primary store, the wizard asks:

```
? Add a sync target? (Use arrow keys)
❯ No — primary only
  Yes — sync peer (bidirectional)
  Yes — backup (push-only)
  Yes — archive (push-only, append intent)
```

If the user picks a sync target, it loops: pick the target store → pick role → configure policy (or accept default) → "Add another target?".

### Generated output (nuxt-default template example)

```ts
// plugins/noydb.client.ts
const db = await createNoydb({
  store: browserIdbStore({ prefix: 'myapp' }),
  sync: [
    {
      store:  awsDynamoStore({ table: 'myapp-live', region: 'ap-southeast-1' }),
      role:   'sync-peer',
      label:  'dynamo-live',
    },
    {
      store:  awsS3Store({ bucket: 'myapp-archive', region: 'ap-southeast-1' }),
      role:   'backup',
      policy: { push: { mode: 'interval', intervalMs: 6 * 60 * 60 * 1000 } },
      label:  's3-nightly',
    },
  ],
})
```

### Policy prompt

For each target, after role selection:

```
? Sync policy for dynamo-live
❯ Default for this store type (on-change / on-open)
  Debounce (30s)
  Interval — enter ms
  Manual only
```

## Acceptance

- [ ] Wizard prompts for sync targets after primary store selection
- [ ] Role and policy prompts per target
- [ ] "Add another target?" loop
- [ ] Generated plugin code uses `SyncTarget[]` shape
- [ ] `--no-sync` flag skips the prompt entirely
- [ ] Wizard tests cover multi-target path
- [ ] Both English and Thai prompt strings (`i18n/en.ts`, `i18n/th.ts`)
- [ ] Changeset for `create-noy-db`

## Related

- #158 — core `SyncTarget[]` API (required)
- #101 — `syncPolicy` scheduling
- Discussion #137 — design rationale
