/**
 * Presence handle — real-time awareness of who is viewing/editing a collection.
 * v0.9 #134 — encrypted ephemeral channel keyed by collection DEK via HKDF.
 *
 * The presence key is derived from the collection DEK so:
 *  - The adapter never learns user identities from presence payloads.
 *  - Presence rotates automatically when the DEK rotates (revoked users
 *    can no longer participate after a DEK rotation).
 *
 * Two transport strategies:
 *  1. **Pub/sub** (real-time): used when the adapter implements
 *     `presencePublish` and `presenceSubscribe`.
 *  2. **Storage-poll** (fallback): presence records are written to a
 *     reserved `_presence_<collection>` collection on the sync adapter
 *     (if available) or local adapter, and polled periodically.
 */

import type { NoydbAdapter, PresencePeer } from './types.js'
import { encrypt, decrypt, generateIV, bufferToBase64, derivePresenceKey } from './crypto.js'

/** Options for constructing a PresenceHandle. @internal */
export interface PresenceHandleOpts {
  /** Local adapter for storage-poll fallback. */
  adapter: NoydbAdapter
  /** Remote (sync) adapter — preferred for broadcasting presence if available. */
  syncAdapter?: NoydbAdapter
  /** Compartment name — used as part of the channel and storage key. */
  compartment: string
  /** Collection name — used as HKDF `info` and channel suffix. */
  collectionName: string
  /** Calling user's ID, embedded unencrypted in storage records. */
  userId: string
  /** Whether encryption is active. When false, presence payloads are stored as JSON. */
  encrypted: boolean
  /** Callback that resolves the collection DEK (used to derive the presence key). */
  getDEK: (collectionName: string) => Promise<CryptoKey>
  /** How long (ms) before a peer's presence is considered stale. Default: 30_000. */
  staleMs?: number
  /** Poll interval (ms) for the storage-poll fallback. Default: 5_000. */
  pollIntervalMs?: number
}

/**
 * Internal storage envelope for the storage-poll fallback.
 * Written to `_presence_<collection>` as `{ userId, lastSeen, iv, data }`.
 */
interface StoragePresenceRecord {
  userId: string
  lastSeen: string
  iv: string    // base64 AES-GCM IV (empty when not encrypted)
  data: string  // base64 ciphertext or JSON string when not encrypted
}

/** Presence handle for a single collection. */
export class PresenceHandle<P> {
  private readonly adapter: NoydbAdapter
  private readonly syncAdapter: NoydbAdapter | undefined
  private readonly compartment: string
  private readonly collectionName: string
  private readonly userId: string
  private readonly encrypted: boolean
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly staleMs: number
  private readonly pollIntervalMs: number
  private readonly channel: string
  private readonly storageCollection: string

  private presenceKey: CryptoKey | null = null
  private subscribers: Array<(peers: PresencePeer<P>[]) => void> = []
  private unsubscribePubSub: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(opts: PresenceHandleOpts) {
    this.adapter = opts.adapter
    this.syncAdapter = opts.syncAdapter
    this.compartment = opts.compartment
    this.collectionName = opts.collectionName
    this.userId = opts.userId
    this.encrypted = opts.encrypted
    this.getDEK = opts.getDEK
    this.staleMs = opts.staleMs ?? 30_000
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000
    // Channel used by pub/sub adapters — compartment-scoped so two collections
    // in the same compartment don't bleed into each other's presence channels.
    this.channel = `${opts.compartment}:${opts.collectionName}:presence`
    // Reserved collection name for the storage-poll fallback.
    this.storageCollection = `_presence_${opts.collectionName}`
  }

  /**
   * Announce yourself (or update your cursor/status).
   * Encrypts `payload` with the presence key and publishes it.
   */
  async update(payload: P): Promise<void> {
    if (this.stopped) return

    const key = await this.getPresenceKey()
    const now = new Date().toISOString()
    const plaintext = JSON.stringify({ userId: this.userId, lastSeen: now, payload })
    let encryptedPayload: string

    if (this.encrypted && key) {
      const iv = generateIV()
      const ivB64 = bufferToBase64(iv)
      const { data } = await encrypt(plaintext, key)
      encryptedPayload = JSON.stringify({ iv: ivB64, data })
    } else {
      encryptedPayload = plaintext
    }

    // Pub/sub path — publish to any adapter that supports it
    const pubAdapter = this.getPubSubAdapter()
    if (pubAdapter?.presencePublish) {
      await pubAdapter.presencePublish(this.channel, encryptedPayload)
    }

    // Storage-poll path — write a record to the storage adapter
    await this.writeStorageRecord(payload, now)
  }

  /**
   * Subscribe to presence updates. The callback receives a filtered, decrypted
   * list of all currently-active peers (excluding yourself, excluding stale).
   *
   * Returns an unsubscribe function. Also call `stop()` to release all resources.
   */
  subscribe(cb: (peers: PresencePeer<P>[]) => void): () => void {
    if (this.stopped) return () => {}

    this.subscribers.push(cb)

    // Start pub/sub listener on first subscriber
    if (this.subscribers.length === 1) {
      this.startListening()
    }

    return () => {
      this.subscribers = this.subscribers.filter(s => s !== cb)
      if (this.subscribers.length === 0) this.stopListening()
    }
  }

  /** Stop all listening and clear resources. */
  stop(): void {
    this.stopped = true
    this.stopListening()
    this.subscribers = []
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async getPresenceKey(): Promise<CryptoKey | null> {
    if (!this.encrypted) return null
    if (!this.presenceKey) {
      try {
        const dek = await this.getDEK(this.collectionName)
        this.presenceKey = await derivePresenceKey(dek, this.collectionName)
      } catch {
        // no-op — presence degrades gracefully if crypto fails
      }
    }
    return this.presenceKey
  }

  private getPubSubAdapter(): NoydbAdapter | undefined {
    // Prefer the sync adapter (it broadcasts to other devices)
    if (this.syncAdapter?.presencePublish) return this.syncAdapter
    if (this.adapter.presencePublish) return this.adapter
    return undefined
  }

  private startListening(): void {
    const pubAdapter = this.getPubSubAdapter()

    if (pubAdapter?.presenceSubscribe) {
      // Real-time pub/sub path
      this.unsubscribePubSub = pubAdapter.presenceSubscribe(
        this.channel,
        (encryptedPayload) => { void this.handlePubSubMessage(encryptedPayload) },
      )
    } else {
      // Storage-poll fallback
      this.pollTimer = setInterval(
        () => { void this.pollStoragePresence() },
        this.pollIntervalMs,
      )
      // Kick off an immediate poll
      void this.pollStoragePresence()
    }
  }

  private stopListening(): void {
    if (this.unsubscribePubSub) {
      this.unsubscribePubSub()
      this.unsubscribePubSub = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async handlePubSubMessage(encryptedPayload: string): Promise<void> {
    try {
      const peer = await this.decryptPresencePayload(encryptedPayload)
      if (!peer || peer.userId === this.userId) return

      const cutoff = new Date(Date.now() - this.staleMs).toISOString()
      if (peer.lastSeen < cutoff) return

      // Deliver only this new peer to subscribers; a full snapshot poll follows
      // on next interval. For pub/sub, we could maintain a map of active peers,
      // but for simplicity: emit a snapshot read from storage.
      await this.pollStoragePresence()
    } catch {
      // Decrypt failure — stale key or tampered payload, ignore
    }
  }

  private async decryptPresencePayload(
    encryptedPayload: string,
  ): Promise<{ userId: string; lastSeen: string; payload: P } | null> {
    const key = await this.getPresenceKey()

    if (!this.encrypted || !key) {
      return JSON.parse(encryptedPayload) as { userId: string; lastSeen: string; payload: P }
    }

    const { iv: ivB64, data } = JSON.parse(encryptedPayload) as { iv: string; data: string }
    const plaintext = await decrypt(ivB64, data, key)
    return JSON.parse(plaintext) as { userId: string; lastSeen: string; payload: P }
  }

  private async writeStorageRecord(payload: P, now: string): Promise<void> {
    const key = await this.getPresenceKey()
    const plaintext = JSON.stringify(payload)
    let iv = ''
    let data: string

    if (this.encrypted && key) {
      const ivBytes = generateIV()
      iv = bufferToBase64(ivBytes)
      const result = await encrypt(plaintext, key)
      data = result.data
    } else {
      data = plaintext
    }

    const record: StoragePresenceRecord = { userId: this.userId, lastSeen: now, iv, data }
    const json = JSON.stringify(record)

    // Use the sync adapter if available (so other devices can read it);
    // fall back to local adapter.
    const storeAdapter = this.syncAdapter ?? this.adapter
    const envelope = {
      _noydb: 1 as const,
      _v: 1,
      _ts: now,
      _iv: '',
      _data: json,
    }
    try {
      await storeAdapter.put(
        this.compartment,
        this.storageCollection,
        this.userId,
        envelope,
      )
    } catch {
      // Presence write failure is non-fatal — the user is still present locally
    }
  }

  private async pollStoragePresence(): Promise<void> {
    if (this.stopped || this.subscribers.length === 0) return

    try {
      const storeAdapter = this.syncAdapter ?? this.adapter
      const ids = await storeAdapter.list(this.compartment, this.storageCollection)
      const cutoff = new Date(Date.now() - this.staleMs).toISOString()
      const peers: PresencePeer<P>[] = []

      for (const id of ids) {
        if (id === this.userId) continue // skip ourselves
        const envelope = await storeAdapter.get(this.compartment, this.storageCollection, id)
        if (!envelope) continue

        const record = JSON.parse(envelope._data) as StoragePresenceRecord
        if (record.lastSeen < cutoff) continue

        let peerPayload: P
        if (this.encrypted && this.presenceKey && record.iv) {
          const plaintext = await decrypt(record.iv, record.data, this.presenceKey)
          peerPayload = JSON.parse(plaintext) as P
        } else {
          peerPayload = JSON.parse(record.data) as P
        }

        peers.push({ userId: record.userId, payload: peerPayload, lastSeen: record.lastSeen })
      }

      for (const cb of this.subscribers) {
        cb(peers)
      }
    } catch {
      // Poll failure is non-fatal
    }
  }
}
