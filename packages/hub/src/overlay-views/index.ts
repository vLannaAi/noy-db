export { withOverlayedView } from './with-overlayed-view.js'
export { OverlayedViewRegistry } from './registry.js'
export { OverlayedCollection } from './virtual-collection.js'
export type {
  OverlayedViewStrategy,
  OverlayedViewStrategyHandle,
} from './types.js'

// Re-export errors for the subpath barrel.
export {
  OverlayBaseIsVirtualError,
  OverlayCollectionUnavailableError,
  OverlayNameCollisionError,
  OverlayIdMismatchError,
} from '../errors.js'
