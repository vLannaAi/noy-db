import { ValidationError } from '../../kernel/errors.js'
import type { OverlayedViewSpec, OverlayedViewStrategy } from './types.js'

/**
 * Register a read-shadow overlay: bind an MV-owned base collection to
 * a user-writable overlay so consumers can express operator-editable
 * lifecycles as one declarative block.
 *
 * See design-history/2026-05-20-dim14-mv-v2-design.md.
 */
export function withOverlayedView(
  spec: OverlayedViewSpec,
): OverlayedViewStrategy {
  if (!spec.name || spec.name.length === 0) {
    throw new ValidationError('withOverlayedView: name is required')
  }
  if (!spec.base || spec.base.length === 0) {
    throw new ValidationError('withOverlayedView: base is required')
  }
  if (!spec.overlay || spec.overlay.length === 0) {
    throw new ValidationError('withOverlayedView: overlay is required')
  }
  if (spec.base === spec.overlay) {
    throw new ValidationError('withOverlayedView: base and overlay must be different collections')
  }
  if (spec.base === spec.name || spec.overlay === spec.name) {
    throw new ValidationError(
      'withOverlayedView: virtual name must differ from both base and overlay collection names',
    )
  }
  if (!spec.shadowField || spec.shadowField.length === 0) {
    throw new ValidationError('withOverlayedView: shadowField is required')
  }
  return {
    __noydb_strategy: 'overlayed-view',
    spec,
  }
}
