/**
 * **@klum-db/lobby** — the Lobby: klum-db's outward framework that
 * orchestrates a *group* of sovereign noy-db vaults.
 *
 * A noy-db vault is a complete, sovereign unit (the container). The
 * Lobby is what holds many of them side by side (the commons) and is
 * the way in (the entrance) — federation, interchange, and custody.
 *
 * This is the foundation surface; federation entry points
 * (`openVaultGroup`, `openStateManagementVault`) land when the
 * federation subsystem is extracted from `@noy-db/hub` (Phase 3).
 *
 * @packageDocumentation
 */

import type { Noydb } from '@noy-db/hub'

/**
 * Orchestrates a group of sovereign noy-db vaults sharing one
 * {@link Noydb} runtime (one store, one keyring root).
 */
export class Lobby {
  /** The Noydb runtime whose vaults this Lobby orchestrates. */
  readonly noydb: Noydb

  constructor(noydb: Noydb) {
    this.noydb = noydb
  }
}

/** Create a {@link Lobby} over an existing {@link Noydb} runtime. */
export function createLobby(noydb: Noydb): Lobby {
  return new Lobby(noydb)
}
