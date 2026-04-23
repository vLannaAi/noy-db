# Issue #154 — feat(tooling): @noy-db/store-probe — runtime reliability monitor

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

Split from #146.

## Summary

`db.monitor(options?)` — attaches to a running `Noydb` instance and continuously checks all attached stores (primary + all sync targets) for liveness, write latency, auth validity, and sync lag.

## Package

`@noy-db/store-probe` (same package as the setup-time probe, ships together)

## API

```ts
const monitor = db.monitor({
  interval:   60_000,
  onDegraded: (event) => console.warn('store degraded', event),
  onRestored: (event) => console.info('store restored', event),
})

monitor.stop()
const snapshot = await monitor.check()  // one-shot
```

## Lightweight checks per interval

| Check | Operation | Threshold |
|---|---|---|
| Liveness | `ping()` or `list(vault, '_probe')` | Fails if throws or > 5 000ms |
| Write latency | Single `put` + `delete` on reserved `_probe` record | Emits `degraded` if p99 > 3× startup baseline |
| Auth validity | Auth error on liveness check | Emits `auth-expired` event |
| Sync lag | Dirty record count per sync target | Emits `sync-lagging` if > threshold |

## Events

```ts
db.on('store:degraded', (e) => { /* surface in UI */ })
db.on('store:restored', (e) => { /* clear warning */ })
```

## Vue / Pinia integration

`useSync()` gains a `storeHealth` reactive field:

```ts
const { storeHealth } = useSync()
// Map<storeName, 'ok' | 'degraded' | 'unreachable' | 'auth-expired'>
```

## Acceptance

- [ ] `db.monitor()` attaches and polls all attached stores
- [ ] `monitor.stop()` detaches cleanly
- [ ] `monitor.check()` returns a one-shot snapshot
- [ ] `store:degraded` / `store:restored` events emitted correctly
- [ ] `useSync().storeHealth` reactive in Vue
- [ ] Changeset for `@noy-db/store-probe`

## Related

- #146 — original combined issue (closed, split here + setup-time probe issue)
- #101 — `syncPolicy` scheduling — monitor's `sync-lagging` check complements the scheduler
- #137 — multi-backend topology
