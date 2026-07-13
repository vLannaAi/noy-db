/**
 * Credential-broker strategy seam (#479, credential-broker spec §5). Lives
 * on the `/with` port (the one seam the kernel spine may import statically)
 * so `Vault` can hold the `NO_BROKER` floor default without a spine→service
 * static import — the same idiom as `port/with/team-strategy.ts`.
 *
 * `BrokerCtx` bundles what the `_broker` seed lifecycle needs (`store`/
 * `vault`/`keyring`) with what the network/cache layer needs (`config`, the
 * `BrokerConfig` the strategy was built with) into one argument, so
 * `BrokerStrategy`'s three methods stay uniform. `NO_BROKER` (the floor
 * default) has no `config` — every method throws before touching `ctx`.
 * @internal
 */
import type { NoydbStore, StoreCredentialSource } from '../../kernel/types.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import { BrokerNotEnabledError } from '../../kernel/errors.js'

/** Construction-time options for `withBroker(config)` (spec §5 client surface). */
export interface BrokerConfig {
  /**
   * Stable id; part of the HKDF info tag AND the proof canonical. MUST be
   * globally-unique / endpoint-derived (spec F4) — reusing one `brokerId`
   * across two endpoints enables a cross-endpoint relay.
   */
  readonly brokerId: string
  /** https broker base URL; its origin is bound into the proof MAC (F4). */
  readonly endpoint: string
  /** Dev-backend session token for `/enroll` (spec decision 1). */
  readonly attestation?: (() => string | Promise<string>) | undefined
  /** DI for tests / non-window runtimes. */
  readonly fetch?: typeof fetch | undefined
  /** Refresh margin in ms, default 60_000. */
  readonly skewMs?: number | undefined
}

/**
 * Per-call context a {@link BrokerStrategy} method needs: the seed API's
 * `store`/`vault`/`keyring`, plus the network client's `config`.
 */
export interface BrokerCtx {
  readonly store: NoydbStore
  readonly vault: string
  readonly keyring: UnlockedKeyring
  readonly config: BrokerConfig
}

/** The vault-bound handle `vault.broker()` returns (spec §5). */
export interface CredentialBrokerHandle {
  /** Generate+persist the `_broker` seed (idempotent), register its proof key. */
  enroll(): Promise<void>
  /** Rotate the seed + re-register (revokes the old proof key after a grace window). */
  rotate(): Promise<void>
  /** Single-flight, per-profile cache of a `StoreCredentialSource`. */
  credentialSource(profile?: string): StoreCredentialSource
}

/** The opt-in strategy contract `withBroker(config)` implements. */
export interface BrokerStrategy {
  /**
   * The `BrokerConfig` this strategy was built with — `NO_BROKER` has none
   * (every method throws before reading it). Exposed so `vault.broker()`
   * can build a {@link BrokerCtx} without a separate `NoydbOptions` field.
   */
  readonly config?: BrokerConfig | undefined
  enroll(ctx: BrokerCtx): Promise<void>
  rotate(ctx: BrokerCtx): Promise<void>
  credentialSource(ctx: BrokerCtx, profile?: string): StoreCredentialSource
}

/**
 * No-op stub — the floor default. Every broker operation throws
 * {@link BrokerNotEnabledError}; opt in with `brokerStrategy: withBroker(config)`
 * (from `@noy-db/hub/broker`) in `createNoydb()`.
 * @internal
 */
export const NO_BROKER: BrokerStrategy = {
  async enroll() { throw new BrokerNotEnabledError() },
  async rotate() { throw new BrokerNotEnabledError() },
  credentialSource() { throw new BrokerNotEnabledError() },
}

/**
 * Build the vault-bound {@link CredentialBrokerHandle} `vault.broker()`
 * returns — factored out of `kernel/vault.ts` to keep that file's footprint
 * to a single accessor line (the kernel-surface ceiling). `getKeyring` is a
 * thunk, not a snapshot: the active keyring can change after `vault.load()`,
 * so each handle method re-reads it fresh at call time.
 */
export function buildCredentialBrokerHandle(
  strategy: BrokerStrategy,
  store: NoydbStore,
  vault: string,
  getKeyring: () => UnlockedKeyring,
): CredentialBrokerHandle {
  const ctx = (): BrokerCtx => ({ store, vault, keyring: getKeyring(), config: strategy.config as BrokerConfig })
  return {
    enroll: () => strategy.enroll(ctx()),
    rotate: () => strategy.rotate(ctx()),
    credentialSource: (profile) => strategy.credentialSource(ctx(), profile),
  }
}
