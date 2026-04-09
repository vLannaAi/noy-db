/**
 * Field descriptors for Yjs-backed fields in @noy-db/yjs.
 * Mirrors the dictKey / i18nText descriptor pattern from @noy-db/core.
 */

/** Descriptor for a Y.Text field (rich text, TipTap/ProseMirror compatible). */
export interface YTextDescriptor {
  readonly _yjsType: 'Y.Text'
}

/** Descriptor for a Y.Map<string> field. */
export interface YMapDescriptor {
  readonly _yjsType: 'Y.Map'
}

/** Descriptor for a Y.Array field. */
export interface YArrayDescriptor {
  readonly _yjsType: 'Y.Array'
}

export type YFieldDescriptor = YTextDescriptor | YMapDescriptor | YArrayDescriptor

/** Declare a Y.Text field (rich text). */
export function yText(): YTextDescriptor {
  return { _yjsType: 'Y.Text' }
}

/** Declare a Y.Map field. */
export function yMap(): YMapDescriptor {
  return { _yjsType: 'Y.Map' }
}

/** Declare a Y.Array field. */
export function yArray(): YArrayDescriptor {
  return { _yjsType: 'Y.Array' }
}
