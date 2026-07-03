/**
 * Vault-side attestation facade.
 *
 * Holds the per-collection attestation field-schema registry and the issue/
 * revoke entry points (`issueAttestation` / `getDocumentSigningPublicKey` /
 * `revoke` / `unrevoke` / `getRevokedDocIds` / `publishRevocationList`). The
 * `*Core` implementations live beside this file; the facade only builds the
 * {@link IssueContext} / {@link RevokeContext} closures and delegates. Every
 * `Vault` dependency arrives via {@link VaultAttestationDeps}.
 *
 * Internal service — reached through `vault.issueAttestation(...)` etc.
 */
import { AttestationError } from '../../kernel/errors.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import type { AttestationFieldSchema, RevocationList } from '@noy-db/attestation'
import type { IssueContext } from './issue.js'
import type { RevokeContext } from './revoke.js'
import type { AttestationStrategy } from './strategy.js'
export { NO_ATTESTATION, type AttestationStrategy } from './strategy.js'

/** Everything the moving attestation methods touched on the vault's `this.*`. */
export interface VaultAttestationDeps {
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** Vault namespace name. */
  readonly vault: string
  /** Per-collection DEK resolver (bound `vault.getDEK`). */
  readonly getDEK: (collection: string) => Promise<EnclaveKey>
  /** The invoking keyring's role (read fresh per call). */
  role(): string
  /** Decrypt a collection record at `locale: 'raw'` (issue side reads the live record). */
  getRawRecord(collection: string, id: string): Promise<Record<string, unknown> | null>
}

export class VaultAttestation {
  /**
   * Per-collection attestation field-schema (issue side). Populated on
   * `collection({ attestation })` via {@link register} and read by
   * {@link issue}. Indexed by collection name.
   */
  private readonly registry = new Map<string, AttestationFieldSchema>()

  constructor(
    private readonly deps: VaultAttestationDeps,
    /**
     * Opt-in capability gate. `NO_ATTESTATION` when
     * `createNoydb({ attestationStrategy })` was omitted — every issue/revoke/
     * signer call then throws `AttestationNotEnabledError`. The facade always
     * exists (it holds the per-collection field-schema registry populated at
     * `collection()` time); only the capability methods are gated.
     */
    private readonly strategy: AttestationStrategy,
  ) {}

  /** Register a collection's attestation field-schema (from `vault.collection`). */
  register(collection: string, schema: AttestationFieldSchema): void {
    this.registry.set(collection, schema)
  }

  async issue(collectionName: string, id: string): Promise<{ docId: string; qr: string; keyId: string; publicKeyB64: string }> {
    const fieldSchema = this.registry.get(collectionName)
    if (!fieldSchema) {
      throw new AttestationError(`issueAttestation: collection '${collectionName}' has no attestation field-schema. Declare it via vault.collection('${collectionName}', { attestation: { fields: [...] } }).`)
    }
    const out = await this.strategy.issueAttestation(this.makeIssueContext(), { collection: collectionName, id, fieldSchema })
    return { docId: out.docId, qr: out.qr, keyId: out.keyId, publicKeyB64: out.publicKeyB64 }
  }

  async getDocumentSigningPublicKey(): Promise<{ keyId: string; publicKeyB64: string }> {
    return this.strategy.getDocumentSigningPublicKey({
      adapter: this.deps.adapter,
      vault: this.deps.vault,
      role: this.deps.role(),
      getDEK: this.deps.getDEK,
    })
  }

  private makeIssueContext(): IssueContext {
    const adapter = this.deps.adapter, vaultName = this.deps.vault
    return {
      store: adapter,
      vault: vaultName,
      role: this.deps.role(),
      getDEK: async () => this.deps.getDEK('_attestations'),
      readRecord: async (collection: string, recId: string) => {
        const env = await adapter.get(vaultName, collection, recId)
        if (!env) return null
        const record = await this.deps.getRawRecord(collection, recId)
        if (record === null) return null
        return { record, version: env._v }
      },
    }
  }

  async revoke(docId: string): Promise<void> {
    await this.strategy.revokeAttestation(this.makeRevokeContext(), docId)
  }

  async unrevoke(docId: string): Promise<void> {
    await this.strategy.unrevokeAttestation(this.makeRevokeContext(), docId)
  }

  async getRevokedDocIds(): Promise<string[]> {
    return this.strategy.getRevokedDocIds(this.makeRevokeContext())
  }

  async publishRevocationList(): Promise<RevocationList> {
    return this.strategy.publishRevocationList(this.makeRevokeContext())
  }

  private makeRevokeContext(): RevokeContext {
    return {
      store: this.deps.adapter,
      vault: this.deps.vault,
      role: this.deps.role(),
      getDEK: async () => this.deps.getDEK('_attestations'),
    }
  }
}
