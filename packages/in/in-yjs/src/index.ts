/**
 * @noy-db/yjs — Yjs Y.Doc interop for noy-db.
 *
 * Enables collaborative rich-text editing with encrypted-at-rest Yjs state.
 * Requires peer dependencies: `@noy-db/core` and `yjs >= 13`.
 *
 * @example
 * ```ts
 * import { yjsCollection, yText } from '@noy-db/in-yjs'
 *
 * const notes = yjsCollection(comp, 'notes', {
 *   yFields: { body: yText() },
 * })
 *
 * const doc = await notes.getYDoc('note-1')
 * doc.getText('body').insert(0, 'Hello world')
 * await notes.putYDoc('note-1', doc)
 * ```
 */

export { yjsCollection, YjsCollection } from './yjs-collection.js'
export type {
  YjsCollectionOptions,
  YjsSnapshot,
} from './yjs-collection.js'

export { yText, yMap, yArray } from './descriptors.js'
export type {
  YFieldDescriptor,
  YTextDescriptor,
  YMapDescriptor,
  YArrayDescriptor,
} from './descriptors.js'
