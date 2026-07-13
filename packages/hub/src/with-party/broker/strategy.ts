/**
 * Service-side shim for the broker strategy seam (#479). The contract
 * itself lives on the `/with` port (`src/port/with/broker-strategy.ts`) so
 * the kernel spine can hold the `NO_BROKER` floor default without a
 * spine→service static import. This file keeps the conventional
 * `<service>/{strategy,active,index}.ts` layout.
 * @internal
 */
export {
  NO_BROKER,
  type BrokerStrategy,
  type BrokerCtx,
  type BrokerConfig,
  type CredentialBrokerHandle,
} from '../../port/with/broker-strategy.js'
