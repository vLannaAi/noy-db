/**
 * YjsCollection — wraps a noy-db Collection<string> (crdt: 'yjs') with
 * Y.Doc-aware `getYDoc` and `putYDoc` methods.
 *
 * The encrypted envelope stores base64(Y.encodeStateAsUpdate(ydoc)) in `_data`.
 * `collection.get(id)` returns this raw base64 string. `getYDoc(id)` decodes
 * it into a Y.Doc and applies any `yFields` initialisation.
 *
 * v0.9 #136
 */

import * as Y from 'yjs'
import type { Vault } from '@noy-db/hub'
import type { YFieldDescriptor } from './descriptors.js'

/** A resolved snapshot of a Yjs-backed record. Field values depend on yFields descriptors. */
export type YjsSnapshot<YF extends Record<string, YFieldDescriptor>> = {
  [K in keyof YF]: YF[K] extends { _yjsType: 'Y.Text' }
    ? Y.Text
    : YF[K] extends { _yjsType: 'Y.Map' }
      ? Y.Map<unknown>
      : Y.Array<unknown>
}

/** Options for creating a YjsCollection. */
export interface YjsCollectionOptions<YF extends Record<string, YFieldDescriptor>> {
  /** The field descriptors — tells YjsCollection which Y.* types to initialise. */
  yFields: YF
}

/**
 * A YjsCollection wraps a noy-db `crdt: 'yjs'` collection and exposes
 * `getYDoc(id)` and `putYDoc(id, ydoc)` instead of the raw `get`/`put` API.
 *
 * Construct via `yjsCollection(vault, name, opts)`.
 */
export class YjsCollection<YF extends Record<string, YFieldDescriptor>> {
  private readonly coll: ReturnType<Vault['collection']>
  private readonly yFields: YF

  /** @internal — use `yjsCollection()` factory instead. */
  constructor(
    private readonly vault: Vault,
    private readonly name: string,
    opts: YjsCollectionOptions<YF>,
  ) {
    this.yFields = opts.yFields
    // Collection<string> with crdt: 'yjs' — T = string (the base64 update blob)
    this.coll = vault.collection<string>(name, { crdt: 'yjs' })
  }

  /**
   * Get the Y.Doc for a record.
   *
   * If the record does not exist, returns a fresh empty Y.Doc with the declared
   * `yFields` initialised (Y.Text / Y.Map / Y.Array as declared).
   *
   * If the record exists, the stored Yjs update is applied to the returned doc.
   */
  async getYDoc(id: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    this.initFields(doc)

    const base64Update = await this.coll.get(id) as string | null
    if (base64Update) {
      const bytes = base64ToUint8Array(base64Update)
      Y.applyUpdate(doc, bytes)
    }

    return doc
  }

  /**
   * Persist a Y.Doc by encoding its state as a Yjs update and storing it
   * as the encrypted envelope payload.
   */
  async putYDoc(id: string, doc: Y.Doc): Promise<void> {
    const update = Y.encodeStateAsUpdate(doc)
    const base64 = uint8ArrayToBase64(update)
    await this.coll.put(id, base64)
  }

  /**
   * Merge a Yjs update into an existing record.
   * Reads the current doc, applies the update, then persists the merged state.
   */
  async applyUpdate(id: string, update: Uint8Array): Promise<void> {
    const doc = await this.getYDoc(id)
    Y.applyUpdate(doc, update)
    await this.putYDoc(id, doc)
  }

  /**
   * Delete the record.
   */
  async delete(id: string): Promise<void> {
    await this.coll.delete(id)
  }

  /**
   * Check whether a record exists.
   */
  async has(id: string): Promise<boolean> {
    return (await this.coll.get(id)) !== null
  }

  // ─── Private ────────────────────────────────────────────────────────

  private initFields(doc: Y.Doc): void {
    for (const [fieldName, descriptor] of Object.entries(this.yFields)) {
      switch (descriptor._yjsType) {
        case 'Y.Text':
          doc.getText(fieldName)
          break
        case 'Y.Map':
          doc.getMap(fieldName)
          break
        case 'Y.Array':
          doc.getArray(fieldName)
          break
      }
    }
  }
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ─── Factory function ─────────────────────────────────────────────────────────

/**
 * Create a `YjsCollection` for a vault.
 *
 * @param vault  An opened NOYDB vault.
 * @param name         Collection name (must not start with `_`).
 * @param opts         Field descriptors (`yFields`) and optional collection settings.
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
export function yjsCollection<YF extends Record<string, YFieldDescriptor>>(
  vault: Vault,
  name: string,
  opts: YjsCollectionOptions<YF>,
): YjsCollection<YF> {
  return new YjsCollection(vault, name, opts)
}
