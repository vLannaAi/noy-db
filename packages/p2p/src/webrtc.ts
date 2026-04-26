/**
 * WebRTC handshake helper — opinionated wrapper around
 * `RTCPeerConnection` that produces a ready-to-use `PeerChannel`.
 *
 * The handshake is split into two halves so the caller can ferry the
 * SDP blobs over whatever signaling channel they prefer (QR code,
 * Matrix room, pastebin, Firebase, signed URL…). Signaling is
 * intentionally out of scope — noy-db has no opinion on how peers
 * discover each other, only on what flows once they do.
 *
 * ```ts
 * // Peer A (initiator)
 * const a = await createOffer({ iceServers })
 * send(a.offer)                           // → signaling channel
 * const answer = await receive()          // ← signaling channel
 * await a.accept(answer)
 * const channel = await a.channel         // ready PeerChannel
 *
 * // Peer B (responder)
 * const offer = await receive()           // ← signaling channel
 * const b = await acceptOffer(offer, { iceServers })
 * send(b.answer)                          // → signaling channel
 * const channel = await b.channel         // ready PeerChannel
 * ```
 *
 * Browser-only. Node consumers who want to interconnect with browsers
 * can plug `@roamhq/wrtc` into the global `RTCPeerConnection` slot; this
 * module does not pull it in so the package has zero runtime deps.
 *
 * @module
 */

import type { PeerChannel } from './channel.js'
import { fromDataChannel } from './channel.js'

type PeerConnection = RTCPeerConnection
type SessionDescription = RTCSessionDescriptionInit

export interface WebRTCOptions {
  /** Optional ICE servers (STUN / TURN). */
  readonly iceServers?: RTCIceServer[]
  /** Label for the `RTCDataChannel`. Default `'noydb'`. */
  readonly label?: string
}

export interface Initiator {
  readonly offer: SessionDescription
  /** Feed in the remote peer's SDP answer to complete the handshake. */
  accept(answer: SessionDescription): Promise<void>
  /** Resolves with the opened `PeerChannel` once the DataChannel is live. */
  readonly channel: Promise<PeerChannel>
  readonly connection: PeerConnection
}

export interface Responder {
  readonly answer: SessionDescription
  /** Resolves with the opened `PeerChannel` once the DataChannel is live. */
  readonly channel: Promise<PeerChannel>
  readonly connection: PeerConnection
}

function requireRTC(): typeof RTCPeerConnection {
  const g = globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }
  if (!g.RTCPeerConnection) {
    throw new Error(
      '[@noy-db/p2p] globalThis.RTCPeerConnection is undefined — use this module in a browser, or polyfill with @roamhq/wrtc in Node',
    )
  }
  return g.RTCPeerConnection
}

/**
 * Build an offer as the initiating peer. Returns the SDP offer to send
 * to the remote peer and a promise for the opened `PeerChannel`.
 */
export async function createOffer(opts: WebRTCOptions = {}): Promise<Initiator> {
  const RTC = requireRTC()
  const pc = new RTC({
    ...(opts.iceServers && { iceServers: opts.iceServers }),
  })

  const dc = pc.createDataChannel(opts.label ?? 'noydb', {
    ordered: true,
  })

  const channelPromise = new Promise<PeerChannel>((resolve, reject) => {
    dc.addEventListener('open', () => resolve(fromDataChannel(dc)))
    dc.addEventListener('error', () => reject(new Error('DataChannel error')))
  })

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitForIceComplete(pc)

  return {
    offer: pc.localDescription ?? offer,
    connection: pc,
    channel: channelPromise,
    async accept(answer) {
      await pc.setRemoteDescription(answer)
    },
  }
}

/**
 * Accept an incoming offer as the responding peer. Returns the SDP
 * answer to send back to the initiator and a promise for the opened
 * `PeerChannel`.
 */
export async function acceptOffer(
  offer: SessionDescription,
  opts: WebRTCOptions = {},
): Promise<Responder> {
  const RTC = requireRTC()
  const pc = new RTC({
    ...(opts.iceServers && { iceServers: opts.iceServers }),
  })

  const channelPromise = new Promise<PeerChannel>((resolve, reject) => {
    pc.addEventListener('datachannel', (ev) => {
      const dc = ev.channel
      if (dc.readyState === 'open') {
        resolve(fromDataChannel(dc))
      } else {
        dc.addEventListener('open', () => resolve(fromDataChannel(dc)))
        dc.addEventListener('error', () => reject(new Error('DataChannel error')))
      }
    })
  })

  await pc.setRemoteDescription(offer)
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitForIceComplete(pc)

  return {
    answer: pc.localDescription ?? answer,
    connection: pc,
    channel: channelPromise,
  }
}

/**
 * Resolve once ICE gathering reaches `'complete'`. Using non-trickle ICE
 * keeps the signaling exchange to a single round-trip — at the cost of
 * a slightly longer initial handshake. Consumers that want trickle ICE
 * can bypass this helper and drive `RTCPeerConnection` directly.
 */
function waitForIceComplete(pc: PeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}
