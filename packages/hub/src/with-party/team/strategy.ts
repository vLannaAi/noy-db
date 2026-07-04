/**
 * Service-side shim for the team strategy seam (#267). The contract itself
 * lives on the `/with` port (`src/port/with/team-strategy.ts`) so the
 * kernel spine can hold the `NO_TEAM` floor default without a
 * spine→service static import (the port-layering rule). This file keeps
 * the conventional `<service>/{strategy,active,index}.ts` layout.
 * @internal
 */
export { NO_TEAM, type TeamStrategy } from '../../port/with/team-strategy.js'
