/**
 * Cross-tab write propagation. A role-agnostic relay: it broadcasts
 * a ciphertext-blind signal ({vault, collection, docId, action}) for every
 * locally-committed write (via onAfterWrite), and on receiving a peer
 * tab's signal it asks the host to refresh that document's in-memory view by
 * re-reading the shared encrypted store. Nothing decrypted crosses the wire.
 */
import type { TabChannel, Unsubscribe } from './tab-coordination.js'
import type { WriteEvent } from '../kernel/write-hooks.js'

export interface TabWriteMsg {
  readonly kind: 'tab-write'
  readonly writerId: string
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly action: 'put' | 'delete'
  readonly baseV: number
  readonly v: number
}

export interface CrossTabWriteRelayOptions {
  /** The broadcast channel (its own — distinct from the presence channel). */
  readonly channel: TabChannel
  /** This tab's id — outgoing signals carry it; incoming self-signals are ignored. */
  readonly writerId: string
  /** Subscribe to committed writes (the host's onAfterWrite). */
  readonly subscribeAfterWrite: (handler: (e: WriteEvent) => void) => Unsubscribe
  /** Refresh a document's in-memory view from the shared store. */
  readonly applyRemoteWrite: (vault: string, collection: string, docId: string, action: 'put' | 'delete') => void | Promise<void>
  /** Report a detected conflict (host captures + converges + emits). */
  readonly reportConflict?: (vault: string, collection: string, docId: string, action: 'put' | 'delete', baseV: number, v: number, ownV: number) => void | Promise<void>
  /** Close the channel on dispose (only when the relay created it). Default false. */
  readonly closeChannelOnDispose?: boolean
}

export class CrossTabWriteRelay {
  readonly #channel: TabChannel
  readonly #writerId: string
  readonly #subscribeAfterWrite: (handler: (e: WriteEvent) => void) => Unsubscribe
  readonly #applyRemoteWrite: (vault: string, collection: string, docId: string, action: 'put' | 'delete') => void | Promise<void>
  readonly #reportConflict: CrossTabWriteRelayOptions['reportConflict']
  readonly #ledger = new Map<string, number>()
  readonly #ownsChannel: boolean
  #unsubMsg: Unsubscribe | undefined
  #unsubWrite: Unsubscribe | undefined
  #started = false
  #disposed = false

  constructor(opts: CrossTabWriteRelayOptions) {
    this.#channel = opts.channel
    this.#writerId = opts.writerId
    this.#subscribeAfterWrite = opts.subscribeAfterWrite
    this.#applyRemoteWrite = opts.applyRemoteWrite
    this.#reportConflict = opts.reportConflict
    this.#ownsChannel = opts.closeChannelOnDispose ?? false
  }

  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    this.#unsubMsg = this.#channel.on('message', (p) => this.#onMessage(p))
    this.#unsubWrite = this.#subscribeAfterWrite((e) => this.#onLocalWrite(e))
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubWrite?.()
    this.#unsubMsg?.()
    if (this.#ownsChannel) this.#channel.close()
  }

  #onLocalWrite(e: WriteEvent): void {
    if (this.#disposed || !this.#channel.isOpen) return
    this.#ledger.set(ledgerKey(e.vault, e.collection, e.docId), e.version)
    const action: 'put' | 'delete' = e.op === 'delete' ? 'delete' : 'put'
    const msg: TabWriteMsg = { kind: 'tab-write', writerId: this.#writerId, vault: e.vault, collection: e.collection, docId: e.docId, action, baseV: e.baseVersion, v: e.version }
    this.#channel.send(JSON.stringify(msg))
  }

  #onMessage(payload: string): void {
    if (this.#disposed) return
    let msg: unknown
    try { msg = JSON.parse(payload) } catch { return }
    if (!isTabWriteMsg(msg) || msg.writerId === this.#writerId) return
    const key = ledgerKey(msg.vault, msg.collection, msg.docId)
    const ownV = this.#ledger.get(key)
    if (ownV !== undefined && msg.baseV < ownV && this.#reportConflict) {
      void Promise.resolve(this.#reportConflict(msg.vault, msg.collection, msg.docId, msg.action, msg.baseV, msg.v, ownV)).catch((err) => {
        console.warn(`[noy-db] cross-tab conflict report failed for ${msg.collection}/${msg.docId}: ` + (err instanceof Error ? err.message : String(err)))
      })
      return
    }
    if (ownV !== undefined && msg.baseV >= ownV) this.#ledger.set(key, msg.v) // remote incorporated our write → advance
    void Promise.resolve(this.#applyRemoteWrite(msg.vault, msg.collection, msg.docId, msg.action)).catch((err) => {
      console.warn(`[noy-db] cross-tab apply failed for ${msg.collection}/${msg.docId}: ` + (err instanceof Error ? err.message : String(err)))
    })
  }
}

function ledgerKey(vault: string, collection: string, docId: string): string {
  // NUL separator: it cannot appear in a vault/collection/docId, so keys never collide.
  return `${vault}\0${collection}\0${docId}`
}

function isTabWriteMsg(x: unknown): x is TabWriteMsg {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o['kind'] === 'tab-write'
    && typeof o['writerId'] === 'string'
    && typeof o['vault'] === 'string'
    && typeof o['collection'] === 'string'
    && typeof o['docId'] === 'string'
    && (o['action'] === 'put' || o['action'] === 'delete')
    && typeof o['baseV'] === 'number'
    && typeof o['v'] === 'number'
}
