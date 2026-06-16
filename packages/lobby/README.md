# @klum-db/lobby

> The **Lobby** — klum-db's outward framework that orchestrates a *group* of sovereign [noy-db](https://github.com/vLannaAi/noy-db) vaults: federation, interchange, and custody. A vault is the container; the Lobby is the orchestrator.

Part of **klum-db** (Thai *klum* กลุ่ม, "group") — developed inside the noy-db monorepo while the kernel boundary stabilizes. See `docs/superpowers/specs/2026-06-16-lobby-framework-design.md`.

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '@klum-db/lobby'

const db = await createNoydb({ store: memory(), user: 'alice', secret: '…' })
const lobby = createLobby(db)
```
