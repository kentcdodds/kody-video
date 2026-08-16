import {
  decodeSyncHeader,
  encodeSyncHeader,
  STUN_ICE_SERVERS,
  SYNC_CHUNK_BYTES,
  SYNC_EOF,
  type SyncBackupHeader,
} from './sync-protocol'
import type { SyncSignaling } from './sync-signaling'

const ICE_GATHER_MS = 8_000
const OPEN_MS = 20_000
const BUFFER_LOW = 64 * 1024

export class SyncTransferError extends Error {
  override readonly name = 'SyncTransferError'
}

export function holdWakeLock(signal: AbortSignal): void {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> }
  }
  if (!nav.wakeLock) return
  let sentinel: WakeLockSentinel | null = null
  void nav.wakeLock
    .request('screen')
    .then((lock) => {
      if (signal.aborted) {
        void lock.release().catch(() => undefined)
        return
      }
      sentinel = lock
    })
    .catch(() => undefined)
  signal.addEventListener(
    'abort',
    () => {
      void sentinel?.release().catch(() => undefined)
    },
    { once: true },
  )
}

function abortError(): DOMException {
  return new DOMException('Send cancelled.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(abortError())
      },
      { once: true },
    )
  })
}

async function waitForIceGathering(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      signal.removeEventListener('abort', onAbort)
      window.clearTimeout(timer)
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        finish()
        resolve()
      }
    }
    const onAbort = () => {
      finish()
      reject(abortError())
    }
    const timer = window.setTimeout(() => {
      finish()
      resolve()
    }, ICE_GATHER_MS)
    pc.addEventListener('icegatheringstatechange', onChange)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function attachFailureWatch(pc: RTCPeerConnection, signal: AbortSignal): void {
  const onState = () => {
    if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
      pc.removeEventListener('connectionstatechange', onState)
      pc.removeEventListener('iceconnectionstatechange', onState)
    }
  }
  pc.addEventListener('connectionstatechange', onState)
  pc.addEventListener('iceconnectionstatechange', onState)
  signal.addEventListener(
    'abort',
    () => {
      pc.removeEventListener('connectionstatechange', onState)
      pc.removeEventListener('iceconnectionstatechange', onState)
      pc.close()
    },
    { once: true },
  )
}

function connectionFailed(pc: RTCPeerConnection): boolean {
  return pc.connectionState === 'failed' || pc.iceConnectionState === 'failed'
}

async function waitForOpen(channel: RTCDataChannel, pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + OPEN_MS
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const state = channel.readyState
    if (state === 'open') return
    if (state === 'closed' || connectionFailed(pc)) {
      throw new SyncTransferError(
        'Could not connect to the other device. Stay on the same Wi‑Fi, or Save backup and import it there.',
      )
    }
    await wait(100, signal)
  }
  throw new SyncTransferError(
    'The other device never connected. Keep both screens open, or Save backup and import it there.',
  )
}

async function waitForDataChannel(
  pc: RTCPeerConnection,
  signal: AbortSignal,
): Promise<RTCDataChannel> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      pc.removeEventListener('datachannel', onChannel)
      signal.removeEventListener('abort', onAbort)
      window.clearTimeout(timer)
    }
    const onChannel = (event: RTCDataChannelEvent) => {
      event.channel.binaryType = 'arraybuffer'
      finish()
      resolve(event.channel)
    }
    const onAbort = () => {
      finish()
      reject(abortError())
    }
    const timer = window.setTimeout(() => {
      finish()
      reject(
        new SyncTransferError(
          'The other device never opened a channel. Keep both screens open, or Save backup and import it there.',
        ),
      )
    }, OPEN_MS)
    pc.addEventListener('datachannel', onChannel)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function newPeer(signal: AbortSignal): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: STUN_ICE_SERVERS })
  attachFailureWatch(pc, signal)
  return pc
}

/** Chrome rejects `a=max-message-size` (and similar) unless lines are CRLF. */
export function normalizeSdp(sdp: string): string {
  return `${sdp.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').trim()}\r\n`
}

export async function openSenderChannel(
  signaling: SyncSignaling,
  signal: AbortSignal,
): Promise<{ pc: RTCPeerConnection; channel: RTCDataChannel }> {
  throwIfAborted(signal)
  const pc = newPeer(signal)
  const channel = pc.createDataChannel('kody-video', { ordered: true })
  channel.binaryType = 'arraybuffer'
  channel.bufferedAmountLowThreshold = BUFFER_LOW
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitForIceGathering(pc, signal)
  const local = pc.localDescription?.sdp
  if (!local) throw new SyncTransferError('Could not build a connection offer.')
  await signaling.publishOffer(normalizeSdp(local))
  const answer = await signaling.waitForAnswer(signal)
  await pc.setRemoteDescription({ type: 'answer', sdp: normalizeSdp(answer) })
  await waitForOpen(channel, pc, signal)
  return { pc, channel }
}

export async function openReceiverChannel(
  signaling: SyncSignaling,
  signal: AbortSignal,
): Promise<{ pc: RTCPeerConnection; channel: RTCDataChannel }> {
  throwIfAborted(signal)
  const pc = newPeer(signal)
  const incoming = waitForDataChannel(pc, signal)
  const offer = await signaling.waitForOffer(signal)
  await pc.setRemoteDescription({ type: 'offer', sdp: normalizeSdp(offer) })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitForIceGathering(pc, signal)
  const local = pc.localDescription?.sdp
  if (!local) throw new SyncTransferError('Could not build a connection answer.')
  await signaling.publishAnswer(normalizeSdp(local))
  const channel = await incoming
  channel.binaryType = 'arraybuffer'
  await waitForOpen(channel, pc, signal)
  return { pc, channel }
}

async function waitForBufferedAmountLow(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (channel.bufferedAmount <= BUFFER_LOW) return
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      channel.removeEventListener('bufferedamountlow', onLow)
      signal.removeEventListener('abort', onAbort)
    }
    const onLow = () => {
      finish()
      resolve()
    }
    const onAbort = () => {
      finish()
      reject(abortError())
    }
    channel.addEventListener('bufferedamountlow', onLow)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function sendBackupOnChannel(
  channel: RTCDataChannel,
  backup: Blob,
  filename: string,
  signal: AbortSignal,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
): Promise<void> {
  throwIfAborted(signal)
  const header: SyncBackupHeader = { v: 1, byteLength: backup.size, filename }
  channel.send(encodeSyncHeader(header))
  let offset = 0
  while (offset < backup.size) {
    throwIfAborted(signal)
    if (channel.readyState !== 'open') {
      throw new SyncTransferError('The connection dropped mid-send. Try again with both screens open.')
    }
    await waitForBufferedAmountLow(channel, signal)
    const end = Math.min(offset + SYNC_CHUNK_BYTES, backup.size)
    const chunk = await backup.slice(offset, end).arrayBuffer()
    channel.send(chunk)
    offset = end
    onProgress?.(offset, backup.size)
  }
  channel.send(SYNC_EOF)
}

export async function receiveBackupOnChannel(
  channel: RTCDataChannel,
  signal: AbortSignal,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): Promise<{ blob: Blob; filename: string }> {
  throwIfAborted(signal)
  const parts: ArrayBuffer[] = []
  let expected = 0
  let received = 0
  let filename = 'project.kodyvideo'
  let sawHeader = false

  return new Promise((resolve, reject) => {
    const finish = () => {
      channel.removeEventListener('message', onMessage)
      channel.removeEventListener('close', onClose)
      channel.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => {
      finish()
      reject(error)
    }
    const onAbort = () => fail(abortError())
    const onClose = () => {
      if (!sawHeader || received < expected) {
        fail(new SyncTransferError('The connection closed before the project finished arriving.'))
      }
    }
    const onError = () => fail(new SyncTransferError('The connection failed while receiving.'))
    const onMessage = (event: MessageEvent) => {
      try {
        throwIfAborted(signal)
        if (typeof event.data === 'string') {
          if (event.data === SYNC_EOF) {
            if (!sawHeader || received !== expected) {
              throw new SyncTransferError('The project arrived incomplete.')
            }
            finish()
            resolve({
              blob: new Blob(parts, { type: 'application/octet-stream' }),
              filename,
            })
            return
          }
          if (sawHeader) throw new SyncTransferError('Unexpected text on the project channel.')
          const header = decodeSyncHeader(event.data)
          expected = header.byteLength
          filename = header.filename
          sawHeader = true
          onProgress?.(0, expected)
          return
        }
        if (!sawHeader) throw new SyncTransferError('Project bytes arrived before the header.')
        if (!(event.data instanceof ArrayBuffer)) {
          throw new SyncTransferError('Unexpected payload on the project channel.')
        }
        parts.push(event.data)
        received += event.data.byteLength
        if (received > expected) throw new SyncTransferError('The project was larger than announced.')
        onProgress?.(received, expected)
      } catch (error) {
        fail(error instanceof Error ? error : new SyncTransferError('Could not receive the project.'))
      }
    }
    channel.addEventListener('message', onMessage)
    channel.addEventListener('close', onClose)
    channel.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function sendBackupToPeer(
  signaling: SyncSignaling,
  backup: Blob,
  filename: string,
  signal: AbortSignal,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  onConnected?: () => void,
): Promise<void> {
  holdWakeLock(signal)
  const { pc, channel } = await openSenderChannel(signaling, signal)
  try {
    onConnected?.()
    await sendBackupOnChannel(channel, backup, filename, signal, onProgress)
  } finally {
    channel.close()
    pc.close()
  }
}

export async function receiveBackupFromPeer(
  signaling: SyncSignaling,
  signal: AbortSignal,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
  onConnected?: () => void,
): Promise<{ blob: Blob; filename: string }> {
  holdWakeLock(signal)
  const { pc, channel } = await openReceiverChannel(signaling, signal)
  try {
    onConnected?.()
    return await receiveBackupOnChannel(channel, signal, onProgress)
  } finally {
    channel.close()
    pc.close()
  }
}
