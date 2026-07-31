export interface CapEntry {
  factory: string
  /** "record" — per-record store; "vault" — pod/bundle store (noy-db-to only). */
  shape: string
  capabilities: Record<string, unknown> | null
  optionDependent: boolean
}

export interface BuildPayloadOpts {
  rootDir: string
  caps: Record<string, CapEntry>
  tag: string
  channel: string
  runUrl: string
  isFirstPublish: (pkgName: string) => boolean
}

export interface BridgePackageEntry {
  name: string
  dir: string
  version: string
  description: string | null
  factory: string
  shape: string
  capabilities: Record<string, unknown> | null
  optionDependent: boolean
  changeType: 'added' | 'updated' | 'version-only'
  changelog: string | null
}

export interface BridgePayload {
  bridge: 1
  repo: string
  version: string
  tag: string
  channel: string
  runUrl: string
  /** Always null for in-repo stores — they pin hub `workspace:*`, not a range. */
  hubPeerRange: null
  packages: BridgePackageEntry[]
}

export function buildPayload(opts: BuildPayloadOpts): BridgePayload

/**
 * True when a failed `npm view` call means the package has never been published
 * (npm's E404). Any other failure is NOT first-publish.
 */
export function isFirstPublishFromError(err: unknown): boolean

/** True when npm knows no version of this package other than the current one. */
export function npmIsFirstPublish(name: string): boolean
