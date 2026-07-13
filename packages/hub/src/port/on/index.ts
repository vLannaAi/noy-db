/**
 * @noy-db/hub/on — the on-* unlock family port.
 *
 * An unlock / auth primitive (`on-password`, `on-webauthn`, `on-oidc`,
 * `on-totp`, `on-shamir`, `on-recovery`, …) binds ONLY to this subpath: the
 * paper-recovery mint primitive plus the keyring/role/permission/rewrap/
 * enroll shapes those packages read and write. `on-recovery` already
 * consumes `mintPaperRecoveryEntry`/`PaperRecoveryEntry` from the root
 * barrel (`@noy-db/hub`); this subpath is the stable, named port onto the
 * same values, mirroring `@noy-db/hub/cargo`.
 *
 * NOTE: these primitives are implemented in `with-party/team/*` (the
 * multi-user keyring service), not in the kernel spine proper — same
 * precedent as `@noy-db/hub/ui` re-exporting from `with-shape/introspection`.
 * The port-layering check only restricts kernel *spine* files (and
 * port-to-port imports) from reaching into a `with-*` service statically;
 * a port itself may.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export { mintPaperRecoveryEntry } from '../../with-party/team/recovery.js'
export type { PaperRecoveryEntry } from '../../with-party/team/recovery.js'
export type { UnlockedKeyring } from '../../with-party/team/keyring.js'
export type { Role, Permissions } from '../../kernel/types.js'
export type { SlotRewrapContext } from '../../with-party/team/rotate-recover.js'
export type { EnrollAuthenticatorOptions } from '../../with-party/team/authenticators.js'
