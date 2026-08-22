/**
 * Device-local sealer contract for the echo reveal-blob (spec decision 5,
 * #940). Lives on the `/with` port (the one seam the kernel spine may
 * import statically) so `NoydbOptions.deviceSeal` can reference this type
 * without a spine→service static import. The concrete implementation
 * (`MemoryDeviceSeal`) and the canonical re-export of this type
 * live in `with-party/team/device-seal.ts`.
 * @internal
 */
export interface NoydbDeviceSeal {
  /** Non-sensitive identifier persisted as `provider_hint`. */
  readonly id: string
  seal(plain: Uint8Array): Promise<Uint8Array>
  /** MUST throw on tamper or wrong provider. */
  unseal(sealed: Uint8Array): Promise<Uint8Array>
}
