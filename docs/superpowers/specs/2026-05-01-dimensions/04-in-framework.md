# Dimension 04 — Framework integrations (`in-*`)

## Purpose

Make noy-db reachable from every framework, host language, and UX layer that small-app builders actually use. Consumers shouldn't have to learn noy-db idioms — they should find idiomatic bindings for their stack. This dimension covers two distinct subdimensions: **(a) host-language SDKs** (Python, Go, Rust, Swift, Kotlin) reading the wire format, and **(b) UX components** that auto-bind to collection schemas (forms, tables, list-detail).

## Current state

13 packages: `in-vue`, `in-pinia`, `in-nuxt`, `in-yjs`, `in-react`, `in-nextjs`, `in-svelte`, `in-zustand`, `in-tanstack-query`, `in-tanstack-table`, `in-ai` (LLM function-calling), `in-rest` (endpoint factory), `in-solid`. All TypeScript / JavaScript host language only.

## Target state

The wire format (envelope spec, keyring spec, bundle spec) is documented as language-neutral. Reference SDKs in major host languages match the TypeScript primitives at least for read-only flows; some grow to full feature parity. UX components for the major frameworks render forms, tables, and detail views directly from collection schemas without hand-wired wiring code — the schema *is* the binding.

## Concrete additions

**Host-language SDKs:**
- `in-python` — read/write SDK; reads/writes the same envelopes; primary use case: data-science consumers / LLM agents writing back to a vault
- `in-go` — server-side SDK; primary use case: bridge servers (`by-server` relay backend implementations)
- `in-rust` — embedded / WASM target; primary use case: native apps via Tauri
- `in-swift` — iOS / macOS native; pairs with `on-biometric`
- `in-kotlin` — Android / JVM; pairs with `on-biometric`
- `in-php` — Laravel / Symfony / WordPress shops (a major SME segment via cPanel-tier hosting); pairs with `to-mysql` / `to-postgres`

(Note: `@noy-db/cli` already exists as tooling outside the `in-*` family; full-parity expansion is tracked in Dimension 11 catch-all.)

**Framework-specific (TS/JS expansion):**
- `in-htmx` — server-rendered with partial swaps; complements `in-rest`
- `in-astro` — content-collection bridge
- `in-remix` — loader/action bridge
- `in-qwik` — resumability-aware bindings
- `in-livewire` — Laravel Livewire components (server-rendered reactive); pairs with `in-php`
- `in-react-native` — RN-native bindings; pairs with `to-mmap-native` (WatermelonDB / Realm lineage)
- `in-capacitor` / `in-tauri` / `in-electron` — host-bridge bindings exposing native unlock paths (`on-biometric`) and native KV stores
- `in-replicache-mutators` — server-authoritative mutator pattern (Replicache / Zero) for apps that want optimistic UI with central conflict resolution
- `in-mcp-server` — exposes a noy-db vault as an MCP (Model Context Protocol) server so Claude / OpenAI / other LLMs can read+write through tool calls

**Auto-generated UI:**
- `in-admin-ui` — Pocketbase / Hasura / Appwrite-style auto-generated CRUD admin panel from collection schemas. Drop-in admin without hand-wired wiring. Composes with Dim 02 for auth gating, Dim 09 (read-only viewer) for the read-only variant.

**UX-component sub-family (proposed naming: `in-ux-*` or new `ui-*` prefix):**
- `in-ux-forms-vue` / `in-ux-forms-react` — auto-derived forms from collection schemas, with validation wired to the same Zod/Valibot/etc. validators used by the collection
- `in-ux-table-vue` / `in-ux-table-react` — auto-derived tables with sort/filter from the schema
- `in-ux-detail-vue` / `in-ux-detail-react` — record detail / edit views with i18n + computed fields rendered correctly
- `in-ux-list-vue` / `in-ux-list-react` — virtualised list with lazy mode awareness
- `in-ux-period-picker` — time-partition (`withPeriods`) navigator

## Non-goals & tradeoffs

- **Re-implementing crypto in language SDKs.** Each must wrap the wire format only and use the language's standard crypto library (Web Crypto equivalent: `cryptography` for Python, `crypto/aes-gcm` for Go, `RustCrypto`, `CryptoKit`, etc.). No bespoke implementations.
- **Full feature parity across all SDKs.** Read-only is the floor; full parity is per-SDK based on demand.
- **UI components that lock styling.** UX components must be unstyled by default — they bring behaviour, not appearance. Pair with frontend-design as a separate concern.
- **Server frameworks pretending to be DBs.** `in-rest` etc. expose endpoints; they don't replace `to-*` backends.

## Dependencies / sequencing

- Wire-format specification document (`docs/spec/wire-format.md`) must exist as a language-neutral contract before non-TS SDKs land. This is a prerequisite, not a downstream artefact.
- Conformance test harness adapted to non-TS SDKs (probably as a fixture format consumed by per-language test runners).
- UX-component sub-family depends on stable schema-introspection API (does the collection expose its validator tree? Today, partially.)

## Cross-references

- `features.yaml` → `frameworks` (current section); may need split into `frameworks` + `host_sdks` + `ux_components`
- Related: Dimension 02 (`on-biometric` pairs with `in-swift`/`in-kotlin`), Dimension 09 (the read-only viewer is itself an `in-*`-style component)
- Spec anchor: `SUBSYSTEMS.md#integrations`

## Open questions

- **Which non-TS SDKs are full vs read-only?** Python full (LLM round-trip), Go full (server), Rust read-only initially, Swift/Kotlin read-only initially?
- **UX components: which framework first?** Vue (matches the first-consumer profile) or React (broader market)?
- **Schema-introspection contract.** Does the collection expose its validator structure as a stable API, or do UX components require the validator schema passed alongside?
- **Distribution channels.** Python via PyPI, Go via Go modules, Rust via crates.io — we move from npm-only to multi-registry. CI implications?
