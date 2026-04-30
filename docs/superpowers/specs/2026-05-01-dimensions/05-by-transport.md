# Dimension 05 — Session-share transports (`by-*`)

## Purpose

Bridge live state between realms — between tabs, between peers, between rooms, between native and web — without requiring a paid relay service. The `by-*` family encodes the transport mechanism; the data being transported is always end-to-end encrypted by the noy-db core, so transports are zero-trust by construction.

## Current state

2 packages: `by-peer` (WebRTC peer-to-peer), `by-tabs` (BroadcastChannel multi-tab sync). The roadmap names two more: `by-server` (WebSocket / SSE relay) and `by-room` (Liveblocks / Yjs y-websocket). Family debut shipped `by-peer` + `by-tabs` together.

## Target state

A complete transport matrix that handles every common live-state share scenario for small apps without forcing the user onto a paid relay:
- **Same-process** (multi-tab, multi-iframe)
- **Same-network** (LAN peer discovery)
- **Across-internet, peer-to-peer** (WebRTC with public STUN)
- **Across-internet, relayed** (free-tier WebSocket / SSE)
- **Room-shared** (collaborative editing)
- **Cross-realm bridging** (web ↔ native, web ↔ desktop)
- **Push** (one-way notifications without a persistent connection)

## Concrete additions

**Already on roadmap (1.0 gate):**
- `by-server` — WebSocket / SSE relay. Free-tier targets: Cloudflare Durable Objects, Deno Deploy, Fly Machines, Vercel Edge Functions
- `by-room` — Liveblocks / Yjs y-websocket adapter; CRDT-aware

**New:**
- `by-mesh` — multi-peer mesh atop `by-peer`; resilient to single-peer drops
- `by-pubsub` — MQTT / NATS subscription transport; for IoT-adjacent or sensor-data scenarios
- `by-bridge` — cross-realm bridge: web ↔ native (deeplink, postMessage, custom-scheme), web ↔ desktop (Electron/Tauri IPC)
- `by-walkie` — push-to-talk bursts of reactivity (high-frequency live cursors, drawing strokes); separates burst-rate ephemeral state from durable record sync
- `by-discovery` — local-network peer discovery (mDNS / WebRTC-LAN signalling); not a transport itself, but bootstraps `by-peer`/`by-mesh`
- `by-sse` — one-way Server-Sent-Events push; lighter than `by-server` for read-only consumers
- `by-webpush` — browser Web Push API; for offline notification arrival
- `by-lan` — UDP multicast where available (Electron/Tauri/Node.js host envs only)
- `by-awareness` — Yjs awareness-protocol-style ephemeral state (cursors, selections, presence pings) separate from durable data sync. Live-collab metadata transport.
- `by-nostr-relay` — Nostr-relay-shaped event distribution (signed events on relays). Doubles as a federation-adjacent transport; coordinates with Dim 15.

## Non-goals & tradeoffs

- **Building and operating a relay service.** noy-db ships the package; the user runs the relay (or uses a free-tier hosted endpoint). We provide reference deploy configs (Cloudflare Workers, Fly, Deno).
- **Centralised presence / authority.** Every `by-*` is peer-equivalent; no transport elects a coordinator.
- **Fanout fairness guarantees.** Relays are best-effort; consistency comes from the noy-db sync engine (CRDT or LWW), not the transport.
- **Discovery without explicit user opt-in.** `by-discovery` requires the user to be in "discoverable" mode; no silent broadcasts.

## Dependencies / sequencing

- Presence / sync engine extracted from `@noy-db/hub/team` (already partially done) so `by-*` packages have a clean integration surface.
- `by-server` ships first per existing 1.0 gate; `by-room` second.
- `by-bridge` depends on a documented host-bridge convention (also relevant to `in-swift`/`in-kotlin` in Dimension 04).
- `by-pubsub` overlaps with `to-pubsub-store` (Dimension 01); decide whether to share infrastructure.

## Cross-references

- `features.yaml` → `transports`
- Related: Dimension 01 (`to-pubsub-store`), Dimension 04 (`in-swift`/`in-kotlin` for cross-realm), Dimension 08 (tamper-evidence may use `by-server` to report telemetry)
- Spec anchor: `SUBSYSTEMS.md#sync-and-transports`

## Open questions

- **Reference relay implementations.** Do we ship `examples/by-server-cloudflare-worker/`, `examples/by-server-deno-deploy/`, etc.? Or only the transport client and let users choose?
- **Authentication on relays.** A relay is end-to-end-untrusted (it never sees plaintext), but should it enforce rate-limiting or origin checks per session? Where does the auth happen?
- **`by-bridge` boundary.** Is "web ↔ native via Capacitor" a single package or one per host (Capacitor, Tauri, Electron, React Native)?
- **`by-discovery` privacy.** mDNS broadcasts a hostname — privacy leak for a "no your damn business" project. Opt-in only, or refuse to ship?
