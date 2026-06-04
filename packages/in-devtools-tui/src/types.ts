import type { Vault } from '@noy-db/hub'
import type { Inspector, VaultInfo, InspectorSnapshot } from '@noy-db/in-devtools'

export type View = 'structure' | 'monitor'
export type DetailTab = 'schema' | 'records'

export interface AppProps {
  /** Reserved for B2.2 (in-app refresh / records browsing); unused by the B2.1 injected-data render. */
  readonly inspector: Inspector
  /** Reserved for B2.2 (in-app refresh / records browsing); unused by the B2.1 injected-data render. */
  readonly vault: Vault
  readonly vaultName: string
  /** Injected in tests so the app renders synchronously without async load races. */
  readonly initial?: { vaults: ReadonlyArray<VaultInfo>; snapshot: InspectorSnapshot }
}

export interface FeedRow {
  readonly time: string        // HH:MM:SS
  readonly user: string
  readonly op: 'put' | 'del'
  readonly target: string      // collection/docId
  readonly versions: string    // "2→3" or "4→·"
  readonly baseKey: string     // collection/docId@baseVersion (overlap detection)
  conflict: boolean
}
