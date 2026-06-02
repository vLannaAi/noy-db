import type { Vault } from '@noy-db/hub'
import type { Inspector, VaultInfo, InspectorSnapshot } from '@noy-db/in-devtools'

export type Focus = 'collections'

export interface AppProps {
  readonly inspector: Inspector
  readonly vault: Vault
  readonly vaultName: string
  /** Injected in tests so the app renders synchronously without async load races. */
  readonly initial?: { vaults: ReadonlyArray<VaultInfo>; snapshot: InspectorSnapshot }
}
