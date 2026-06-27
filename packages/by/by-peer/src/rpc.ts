/**
 * JSON-RPC protocol over a `PeerChannel`.
 *
 * Request shape:
 *   `{ t: 'req', id, method, args }`
 * Response shape (success):
 *   `{ t: 'res', id, ok: true, result }`
 * Response shape (error):
 *   `{ t: 'res', id, ok: false, error: { name, message, version? } }`
 *
 * Why not reuse msgpack/protobuf? The payloads are already base64-encoded
 * ciphertext — further binary packing saves ~8-12% at a large dependency
 * cost. JSON over UTF-8 is inspectable, fits the zero-dependency ethos,
 * and WebRTC DataChannel string mode already frames for us.
 *
 * @module
 */

import type { PeerChannel } from './channel.js'

/** Wire format discriminator for RPC messages. */
export type RpcMessage = RpcRequest | RpcResponse

export interface RpcRequest {
  readonly t: 'req'
  readonly id: string
  readonly method: string
  readonly args: readonly unknown[]
}

export interface RpcResponse {
  readonly t: 'res'
  readonly id: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { name: string; message: string; version?: number }
}

/** Handler invoked when an RPC request arrives. Return value is serialized as `result`. */
export type RpcHandler = (method: string, args: readonly unknown[]) => Promise<unknown>

/** Options for a client-side RPC caller. */
export interface RpcClientOptions {
  /** Max milliseconds to wait for a response before rejecting. */
  timeoutMs?: number
}

/** Client: wrap a `PeerChannel` in a `call(method, args)` helper. */
export function createRpcClient(channel: PeerChannel, opts: RpcClientOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000
  type Pending = {
    resolve: (v: unknown) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
  const pending = new Map<string, Pending>()
  let counter = 0

  const offMessage = channel.on('message', (payload) => {
    let msg: RpcMessage
    try {
      msg = JSON.parse(payload) as RpcMessage
    } catch {
      return
    }
    if (msg.t !== 'res') return
    const entry = pending.get(msg.id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(msg.id)
    if (msg.ok) {
      entry.resolve(msg.result)
    } else {
      const e = msg.error ?? { name: 'Error', message: 'unknown remote error' }
      const err = new Error(e.message)
      err.name = e.name
      if (typeof e.version === 'number') {
        ;(err as Error & { version?: number }).version = e.version
      }
      entry.reject(err)
    }
  })

  const offClose = channel.on('close', () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('PeerChannel closed before response'))
    }
    pending.clear()
  })

  return {
    async call<T = unknown>(method: string, args: readonly unknown[]): Promise<T> {
      const id = `${Date.now().toString(36)}-${(++counter).toString(36)}`
      const req: RpcRequest = { t: 'req', id, method, args }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        })
        try {
          channel.send(JSON.stringify(req))
        } catch (err) {
          clearTimeout(timer)
          pending.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    dispose() {
      offMessage()
      offClose()
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('RPC client disposed'))
      }
      pending.clear()
    },
  }
}

/** Server: dispatch incoming RPC requests through a handler. Returns a dispose fn. */
export function serveRpc(channel: PeerChannel, handler: RpcHandler): () => void {
  async function handle(payload: string): Promise<void> {
    let msg: RpcMessage
    try {
      msg = JSON.parse(payload) as RpcMessage
    } catch {
      return
    }
    if (msg.t !== 'req') return

    let response: RpcResponse
    try {
      const result = await handler(msg.method, msg.args)
      response = { t: 'res', id: msg.id, ok: true, result }
    } catch (err) {
      const e = err as Error & { version?: number }
      response = {
        t: 'res',
        id: msg.id,
        ok: false,
        error: {
          name: e.name ?? 'Error',
          message: e.message ?? String(err),
          ...(typeof e.version === 'number' && { version: e.version }),
        },
      }
    }

    if (!channel.isOpen) return
    try {
      channel.send(JSON.stringify(response))
    } catch {
      // Channel closed mid-response — nothing to do.
    }
  }

  const offMessage = channel.on('message', (payload) => {
    void handle(payload)
  })

  return () => offMessage()
}
