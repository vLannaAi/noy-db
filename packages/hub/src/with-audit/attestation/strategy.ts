import type { NoydbStore } from '../../kernel/types.js'
import type { RevocationList } from '@noy-db/attestation'
import type { IssueContext, IssueArgs, IssueResult } from './issue.js'
import type { RevokeContext } from './revoke.js'
import { AttestationNotEnabledError } from '../../kernel/errors.js'

/**
 * Deps the signing-public-key lookup needs. Unlike issue/revoke there is no
 * per-call context object for it, so the vault facade assembles this at call
 * time (reading `role` fresh).
 */
export interface SignerLookupDeps {
  readonly adapter: NoydbStore
  readonly vault: string
  /** The invoking keyring's role, read fresh by the caller per call. */
  readonly role: string
  /** Per-collection DEK resolver (bound `vault.getDEK`). */
  readonly getDEK: (collection: string) => Promise<CryptoKey>
}

/**
 * Attestation capability strategy — the six on-demand methods the vault's
 * attestation delegators route through. The active engine ({@link withAttestation})
 * dynamically imports the issue/revoke/signer cores (keeping them out of the floor
 * bundle); {@link NO_ATTESTATION} throws. The vault-side {@link VaultAttestation}
 * facade holds the per-collection field-schema registry and builds the per-call
 * contexts, then delegates here.
 * @internal
 */
export interface AttestationStrategy {
  issueAttestation(ctx: IssueContext, args: IssueArgs): Promise<IssueResult>
  getDocumentSigningPublicKey(deps: SignerLookupDeps): Promise<{ keyId: string; publicKeyB64: string }>
  revokeAttestation(ctx: RevokeContext, docId: string): Promise<void>
  unrevokeAttestation(ctx: RevokeContext, docId: string): Promise<void>
  getRevokedDocIds(ctx: RevokeContext): Promise<string[]>
  publishRevocationList(ctx: RevokeContext): Promise<RevocationList>
}

/**
 * No-op stub — the floor default. Every capability method throws
 * {@link AttestationNotEnabledError}; opt in with
 * `attestationStrategy: withAttestation()` in createNoydb. @internal
 */
export const NO_ATTESTATION: AttestationStrategy = {
  async issueAttestation() { throw new AttestationNotEnabledError() },
  async getDocumentSigningPublicKey() { throw new AttestationNotEnabledError() },
  async revokeAttestation() { throw new AttestationNotEnabledError() },
  async unrevokeAttestation() { throw new AttestationNotEnabledError() },
  async getRevokedDocIds() { throw new AttestationNotEnabledError() },
  async publishRevocationList() { throw new AttestationNotEnabledError() },
}
