/**
 * **@noy-db/in-nextjs/client** — client-component hooks.
 *
 * Re-export of `@noy-db/in-react` so `'use client'` files don't
 * accidentally pull in `next/headers` (which only works in server
 * contexts and breaks the client bundle).
 *
 * Use inside any Next.js client component:
 *
 * ```tsx
 * 'use client'
 * import { useNoydb, useVault, useCollection } from '@noy-db/in-nextjs/client'
 * ```
 *
 * @packageDocumentation
 */

export * from '@noy-db/in-react'
