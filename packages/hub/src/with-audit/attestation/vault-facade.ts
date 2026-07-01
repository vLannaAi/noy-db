/**
 * Vault-side attestation facade, lifted off the `Vault` god-object (Phase 5 A2
 * of the microkernel refactoring).
 *
 * Holds the per-collection attestation field-schema registry and the issue/
 * revoke entry points (`issueAttestation` / `getDocumentSigningPublicKey` /
 * `revoke` / `unrevoke` / `getRevokedDocIds` / `publishRevocationList`). The
 * `*Core` implementations already live beside this file; the facade only builds
 * the {@link IssueContext} / {@link RevokeContext} (the `make*Context` closures
 * that used to sit on `Vault`) and delegates. Behaviour is byte-identical to the
 * inline methods it replaced — every dependency the moving code touched on
 * `this.*` arrives via {@link VaultAttestationDeps}.
 *
 * Internal subsystem — reached through `vault.issueAttestation(...)` etc.
 */
import { AttestationError } from '../../kernel/errors.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { AttestationFieldSchema, RevocationList } from '@noy-db/attestation'
import type { IssueContext } from './issue.js'
import type { RevokeContext } from './revoke.js'

/** Everything the moving attestation methods touched on the vault's `this.*`. */
export interface VaultAttestationDeps {
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** Vault namespace name. */
  readonly vault: string
  /** Per-collection DEK resolver (bound `vault.getDEK`). */
  readonly getDEK: (collection: string) => Promise<CryptoKey>
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

  constructor(private readonly deps: VaultAttestationDeps) {}

  /** Register a collection's attestation field-schema (from `vault.collection`). */
  register(collection: string, schema: AttestationFieldSchema): void {
    this.registry.set(collection, schema)
  }

  async issue(collectionName: string, id: string): Promise<{ docId: string; qr: string; keyId: string; publicKeyB64: string }> {
    const fieldSchema = this.registry.get(collectionName)
    if (!fieldSchema) {
      throw new AttestationError(`issueAttestation: collection '${collectionName}' has no attestation field-schema. Declare it via vault.collection('${collectionName}', { attestation: { fields: [...] } }).`)
    }
    const { issueAttestationCore } = await import('./issue.js')
    const out = await issueAttestationCore(this.makeIssueContext(), { collection: collectionName, id, fieldSchema })
    return { docId: out.docId, qr: out.qr, keyId: out.keyId, publicKeyB64: out.publicKeyB64 }
  }

  async getDocumentSigningPublicKey(): Promise<{ keyId: string; publicKeyB64: string }> {
    const { loadSigner, loadOrCreateSigner } = await import('./signer.js')
    // Reading an existing public key is open to any role that holds the
    // _attestations DEK — the public key is not secret. But MINTING the
    // signer is the firm's identity operation (same rule as issueAttestation):
    // a non-owner read must not silently create it.
    const existing = await loadSigner(this.deps.adapter, this.deps.vault, this.deps.getDEK)
    if (existing) return { keyId: existing.keyId, publicKeyB64: existing.publicKeyB64 }
    if (this.deps.role() !== 'owner') {
      throw new AttestationError(`getDocumentSigningPublicKey: no document-signing key exists yet; only the 'owner' may mint it. Caller is '${this.deps.role()}'. Have the owner issue an attestation (or call this) first.`)
    }
    const signer = await loadOrCreateSigner(this.deps.adapter, this.deps.vault, this.deps.getDEK)
    return { keyId: signer.keyId, publicKeyB64: signer.publicKeyB64 }
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
    const { revokeDocCore } = await import('./revoke.js')
    await revokeDocCore(this.makeRevokeContext(), docId)
  }

  async unrevoke(docId: string): Promise<void> {
    const { unrevokeDocCore } = await import('./revoke.js')
    await unrevokeDocCore(this.makeRevokeContext(), docId)
  }

  async getRevokedDocIds(): Promise<string[]> {
    const { getRevokedDocIdsCore } = await import('./revoke.js')
    return getRevokedDocIdsCore(this.makeRevokeContext())
  }

  async publishRevocationList(): Promise<RevocationList> {
    const { publishRevocationListCore } = await import('./revoke.js')
    return publishRevocationListCore(this.makeRevokeContext())
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
