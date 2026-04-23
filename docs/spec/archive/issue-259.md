# Issue #259 — feat(in-nextjs): @noy-db/in-nextjs — Next.js App Router helpers

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-23
- **Closed:** 2026-04-23
- **Milestone:** Fork · Integrations (@noy-db/in-*)
- **Labels:** type: feature

---

## Target package

\`@noy-db/in-nextjs\` (new)

## Problem

\`@noy-db/in-react\` (#186) gives the client hooks, but Next.js App Router has its own concerns that don't fit the "just React" mould:

- Server components cannot use hooks — they read data via async functions at render time
- Route handlers (\`app/api/…/route.ts\`) need vault access without the client bundle
- Middleware runs in the edge runtime with different constraints
- Streaming + Suspense boundaries want to integrate with noy-db's async \`loadAll\` / \`query\`

## Scope

- **Server helpers** — \`getNoydb()\` (reads vault handle from cookie/header), \`getVault(name)\`, and typed collection helpers for server components.
- **Route handler utilities** — \`withVault(handler)\` wrapper that unlocks a vault, passes it to the handler, and closes on response.
- **Client hook bridge** — re-exports from \`@noy-db/in-react\` plus a \`<NoydbBoundary>\` wrapper for the App Router's Suspense integration.
- **Cookie-based session** — default session store for the unlock handshake (optional; consumers can plug their own).

## Non-goals

- Pages Router support (legacy; not worth a dedicated surface).
- Middleware that decrypts on every request (defeats the zero-knowledge posture).
- Runtime cookie encryption override — uses Next's built-in \`cookies()\` API unchanged.

## Acceptance

- [ ] \`@noy-db/in-nextjs\` package with server + client exports
- [ ] \`getNoydb()\` / \`getVault()\` / \`withVault()\` server helpers
- [ ] Re-export of \`@noy-db/in-react\` hooks for client components
- [ ] Tests mock Next's \`cookies()\` and \`headers()\` — no actual Next.js runtime needed

## Related

- #186 \`@noy-db/in-react\`
- #109 session tokens
- #113 magic-link (fits the cookie flow nicely)
