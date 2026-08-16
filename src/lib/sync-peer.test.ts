import { describe, expect, it } from 'vitest'
import { receiveBackupOnChannel, sendBackupOnChannel } from './sync-peer'
import { STUN_ICE_SERVERS } from './sync-protocol'

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
})
