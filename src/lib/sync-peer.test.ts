import { describe, expect, it, vi } from 'vitest'
import { normalizeSdp, receiveBackupOnChannel, sendBackupOnChannel } from './sync-peer'
import { encodeSyncHeader, STUN_ICE_SERVERS } from './sync-protocol'

async function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', done)
    window.setTimeout(resolve, 4000)
  })
}

async function connectedPair(): Promise<{
  sender: RTCDataChannel
  receiver: RTCDataChannel
  close: () => void
}> {
  const left = new RTCPeerConnection({ iceServers: STUN_ICE_SERVERS })
  const right = new RTCPeerConnection({ iceServers: STUN_ICE_SERVERS })
  const incoming = new Promise<RTCDataChannel>((resolve) => {
    right.addEventListener('datachannel', (event) => {
      event.channel.binaryType = 'arraybuffer'
      resolve(event.channel)
    })
  })
  const sender = left.createDataChannel('kody-video', { ordered: true })
  sender.binaryType = 'arraybuffer'
  const offer = await left.createOffer()
  await left.setLocalDescription(offer)
  await waitForIce(left)
  await right.setRemoteDescription(left.localDescription!)
  const answer = await right.createAnswer()
  await right.setLocalDescription(answer)
  await waitForIce(right)
  await left.setRemoteDescription(right.localDescription!)
  const receiver = await incoming
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('channel did not open')), 8000)
    if (sender.readyState === 'open' && receiver.readyState === 'open') {
      window.clearTimeout(timer)
      resolve()
      return
    }
    sender.onopen = () => {
      if (receiver.readyState === 'open') {
        window.clearTimeout(timer)
        resolve()
      }
    }
    receiver.onopen = () => {
      if (sender.readyState === 'open') {
        window.clearTimeout(timer)
        resolve()
      }
    }
  })
  return {
    sender,
    receiver,
    close: () => {
      sender.close()
      receiver.close()
      left.close()
      right.close()
    },
  }
}

describe('SDP line endings', () => {
  it('rewrites LF-only SDP so Chrome will parse data-channel lines', () => {
    const sdp = 'v=0\na=max-message-size:262144\n'
    expect(normalizeSdp(sdp)).toBe('v=0\r\na=max-message-size:262144\r\n')
  })
})

describe('sync DataChannel transfer', () => {
  it('moves backup bytes peer-to-peer', async () => {
    const pair = await connectedPair()
    const payload = new Uint8Array(80_000)
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
    const backup = new Blob([payload], { type: 'application/octet-stream' })
    const signal = new AbortController().signal
    const received = receiveBackupOnChannel(pair.receiver, signal)
    await sendBackupOnChannel(pair.sender, backup, 'trip.kodyvideo', signal)
    const result = await received
    expect(result.filename).toBe('trip.kodyvideo')
    expect(result.blob.size).toBe(backup.size)
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(bytes).toEqual(payload)
    pair.close()
  })

  it('completes receive when the peer closes after all bytes without EOF', async () => {
    const pair = await connectedPair()
    const payload = new Uint8Array(1200)
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 199
    const signal = new AbortController().signal
    let gotAllBytes = false
    const received = receiveBackupOnChannel(pair.receiver, signal, (got, total) => {
      if (got === total) gotAllBytes = true
    })
    pair.sender.send(
      encodeSyncHeader({ v: 1, byteLength: payload.byteLength, filename: 'no-eof.kodyvideo' }),
    )
    pair.sender.send(payload.buffer)
    // Close only after the payload is on the receiver. Immediate close can
    // beat the last message on a loaded CI runner and fail this as a flake.
    await vi.waitFor(() => expect(gotAllBytes).toBe(true))
    pair.sender.close()
    const result = await received
    expect(result.filename).toBe('no-eof.kodyvideo')
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(payload)
    pair.close()
  })

  it('rejects receive when the peer closes before all bytes arrive', async () => {
    const pair = await connectedPair()
    const signal = new AbortController().signal
    const received = receiveBackupOnChannel(pair.receiver, signal)
    pair.sender.send(encodeSyncHeader({ v: 1, byteLength: 10_000, filename: 'cut.kodyvideo' }))
    pair.sender.send(new Uint8Array(200).buffer)
    pair.sender.close()
    await expect(received).rejects.toThrow(/closed before the project finished/)
    pair.close()
  })

  it('treats a receiver hang-up after EOF as a successful send', async () => {
    const pair = await connectedPair()
    const payload = new Uint8Array(40_000)
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
    const backup = new Blob([payload], { type: 'application/octet-stream' })
    const signal = new AbortController().signal
    const received = receiveBackupOnChannel(pair.receiver, signal).then((result) => {
      pair.receiver.close()
      return result
    })
    await sendBackupOnChannel(pair.sender, backup, 'hangup.kodyvideo', signal)
    const result = await received
    expect(result.filename).toBe('hangup.kodyvideo')
    expect(result.blob.size).toBe(backup.size)
    pair.close()
  })

  it('rejects send when the channel closes mid-transfer', async () => {
    const pair = await connectedPair()
    const backup = new Blob([new Uint8Array(80_000)], { type: 'application/octet-stream' })
    const signal = new AbortController().signal
    const sending = sendBackupOnChannel(pair.sender, backup, 'cut.kodyvideo', signal, (sent) => {
      if (sent > 0) pair.sender.close()
    })
    await expect(sending).rejects.toThrow(/dropped mid-send/)
    pair.close()
  })
})
