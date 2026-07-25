/**
 * `@noy-db/hub/share-link` — the portal share-link grammar (#806).
 *
 * A standalone subpath: pure string/`URL` code addressing
 * `vault / period / collection / record` as one canonical link shape
 * (`/r/{vaultHandle}/{collection}/{recordId}?period=…&v=…#g={token}`)
 * shared by the LIFF permalink, PWA, and vendor-console surfaces. The
 * single-use grant token travels ONLY in the URL fragment (the
 * on-magic-link transport rule — fragments never reach server logs).
 *
 * No crypto, no store, no hub floor — import this from a LIFF shell,
 * a PWA, or klum-db without dragging anything else. The grammar is a
 * frozen contract: the export surface is pinned by
 * `__tests__/share-link-surface-golden.test.ts`.
 *
 * @module
 */

export { buildShareLink, parseShareLink, ShareLinkParseError } from './share-link.js'
export type { ShareLink, ShareLinkParts, ShareLinkErrorCode } from './share-link.js'
