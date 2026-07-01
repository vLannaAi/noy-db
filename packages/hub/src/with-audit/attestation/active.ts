import { AttestationError } from '../../kernel/errors.js'
import type { AttestationStrategy } from './strategy.js'

/**
 * Enable the attestation capability.
 * Pass to `createNoydb({ attestationStrategy: withAttestation() })` to make the
 * vault's `issueAttestation` / `getDocumentSigningPublicKey` / `revokeAttestation`
 * / `unrevokeAttestation` / `getRevokedDocIds` / `publishRevocationList` methods
 * live. The issue/revoke/signer engines are dynamically imported here, so they
 * stay out of the floor bundle until opted in.
 */
export function withAttestation(): AttestationStrategy {
  return {
    async issueAttestation(ctx, args) {
      const { issueAttestationCore } = await import('./issue.js')
      return issueAttestationCore(ctx, args)
    },
    async getDocumentSigningPublicKey(deps) {
      const { loadSigner, loadOrCreateSigner } = await import('./signer.js')
      // Reading an existing public key is open to any role that holds the
      // _attestations DEK — the public key is not secret. But MINTING the
      // signer is the firm's identity operation (same rule as issueAttestation):
      // a non-owner read must not silently create it.
      const existing = await loadSigner(deps.adapter, deps.vault, deps.getDEK)
      if (existing) return { keyId: existing.keyId, publicKeyB64: existing.publicKeyB64 }
      if (deps.role !== 'owner') {
        throw new AttestationError(`getDocumentSigningPublicKey: no document-signing key exists yet; only the 'owner' may mint it. Caller is '${deps.role}'. Have the owner issue an attestation (or call this) first.`)
      }
      const signer = await loadOrCreateSigner(deps.adapter, deps.vault, deps.getDEK)
      return { keyId: signer.keyId, publicKeyB64: signer.publicKeyB64 }
    },
    async revokeAttestation(ctx, docId) {
      const { revokeDocCore } = await import('./revoke.js')
      return revokeDocCore(ctx, docId)
    },
    async unrevokeAttestation(ctx, docId) {
      const { unrevokeDocCore } = await import('./revoke.js')
      return unrevokeDocCore(ctx, docId)
    },
    async getRevokedDocIds(ctx) {
      const { getRevokedDocIdsCore } = await import('./revoke.js')
      return getRevokedDocIdsCore(ctx)
    },
    async publishRevocationList(ctx) {
      const { publishRevocationListCore } = await import('./revoke.js')
      return publishRevocationListCore(ctx)
    },
  }
}
