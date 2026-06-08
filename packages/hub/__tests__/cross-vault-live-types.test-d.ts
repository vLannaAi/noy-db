/**
 * Type-compat test: CrossVaultLiveQuery and CrossVaultLiveAggregation must be
 * assignable to LiveQuery / LiveAggregation respectively (shape-compatible
 * facades). Validated by `pnpm typecheck` (tsconfig.typetest.json).
 */
import { expectTypeOf } from 'vitest'
import type { LiveQuery } from '../src/query/live.js'
import type { LiveAggregation } from '../src/aggregate/aggregation.js'
import type { CrossVaultLiveQuery, CrossVaultLiveAggregation } from '../src/federation/index.js'

expectTypeOf<CrossVaultLiveQuery<{ amount: number }>>().toMatchTypeOf<LiveQuery<{ amount: number }>>()
expectTypeOf<CrossVaultLiveAggregation<{ total: number }>>().toMatchTypeOf<LiveAggregation<{ total: number }>>()
