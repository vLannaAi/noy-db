# Dimension 08 — Tamper-evidence (reframed from "tamper-prevention")

## Purpose

Make post-decrypt observation visible (so the issuer learns when a recipient is being snooped on) and make captured access-tokens unusable for replay (so a stolen one-shot capability burns on use). This dimension explicitly does **not** try to hide plaintext from someone who controls the runtime — that's a physics-class impossibility in JS/TS browsers and we don't pretend otherwise.

## The hard truth this dimension acknowledges

In a browser, JavaScript runtime, or any environment where the user (or an attacker) controls DevTools, extensions, or the debugger, **plaintext after decryption is fully readable**. The crypto-research and DRM literatures have spent decades on this; the consensus result is *raise cost of attack*, never *prevent it*. White-box crypto, code obfuscation, anti-debug tricks — all defeated by determined adversaries within bounded time.

The honest design therefore reframes the goal from **prevention** (impossible) to two achievable patterns:
- **(8a) Tamper-evidence** — telemetry that reports likely-observation events to the issuer, so they learn (perhaps after the fact) that a recipient was compromised.
- **(8b) One-shot capabilities** — server- or relay-issued caps that authorise exactly one decrypt, with the unwrap material burned on use, so a stolen cap doesn't replay.

Both are real, both are useful, and neither claims to "protect plaintext from a controlled runtime."

## Current state

- The architecture invariant *stores see only ciphertext* is enforced (zero-knowledge at storage).
- Plaintext after decrypt is the application's responsibility; no defence layer exists.
- `on-threat` provides the threat triad (lockout, duress, honeypot) at the **unlock boundary**, not the post-decrypt boundary.

## Target state

Two opt-in primitives layered on top of the existing crypto core, both default-off, both honestly documented:

**(8a) `withTamperEvidence({ channel, signals })`**
- Runtime telemetry collector watching for observable signals: console-eval markers, `devtools-detector`-style timing tells, extension-API surface presence (`chrome.runtime`, `browser.runtime`), DOM mutation by foreign scripts, integrity-hash mismatch in expected window properties.
- Reports detected likely-observation events to a configurable channel (issuer relay, local audit log, callback).
- **Honest documentation:** false-positive rate is non-zero, false-negative rate is non-zero, determined adversaries can suppress the signals. We say so.

**(8b) `withOneShotEnvelope({ relay, ttl })`**
- A capability is issued by a relay (server, peer, or self) authorising one decrypt.
- The relay holds the unwrap material; on use, it burns the material (delete-after-read).
- Plaintext is still exposed to the consuming runtime once, but the *capability* doesn't replay — a stolen capability post-burn is useless.
- TTL bounds the window between issue and use.
- Composes with `by-server` (Dimension 05) for the relay layer.

## Concrete additions

- `@noy-db/with-tamper-evidence` — the (8a) primitive, opt-in via `createNoydb({ defense: withTamperEvidence(...) })`
- `@noy-db/with-one-shot-envelope` — the (8b) primitive
- `@noy-db/relay-burn` — reference relay implementation for (8b) (Cloudflare Worker, Deno Deploy, Fly Machines)
- Documentation page: `docs/subsystems/defense.md` — explicit honest narrative about the physics ceiling

## Non-goals & tradeoffs

- **White-box crypto.** No.
- **Code obfuscation as a defence.** No (raises bug count, defers attackers by hours).
- **Anti-debug arms races.** No.
- **Preventing plaintext leak from a controlled runtime.** Impossible. We say so loudly.
- **DRM-style enforcement.** Wrong project.

## Dependencies / sequencing

- `by-server` (Dimension 05) ships first — (8b) needs a relay layer.
- `on-threat` family integrations: tamper-evidence signals can trigger threat-triad responses (lockout, duress, honeypot escalation).
- Reference relay-burn implementations need free-tier hosts (Cloudflare Workers, Deno Deploy) — couples to deploy-templates work.

## Cross-references

- `features.yaml` → propose new `defense` section
- Related: Dimension 02 (`on-threat`), Dimension 05 (`by-server` for relay), Dimension 09 (the read-only viewer is a natural consumer of (8b))
- Spec anchor: new `SUBSYSTEMS.md#defense-realistic` section

## Open questions

- **(8a) signal selection.** Which observability tells are reliable enough to ship by default, vs opt-in? `devtools-detector`-style timing tricks are notoriously flaky.
- **(8a) telemetry channel.** Local audit log, issuer relay, or both? Privacy implications of reporting "I'm being observed" back to the issuer.
- **(8a) signal suppression resistance.** Some signals are easy to suppress (hide DevTools open) and some harder. We document, but should we tier signals (`signal: 'high-confidence' | 'low-confidence'`)?
- **(8b) relay trust.** The relay sees the wrap material and the burn signal; can it lie about the burn? Audit log of burns?
- **(8b) UX of expiry.** What does the consuming app show when a one-shot capability has expired or already been burned?
- **Integration with `by-room` / collaborative editing.** One-shot doesn't compose with continuous editing; only static read scenarios fit. Documented limitation.
