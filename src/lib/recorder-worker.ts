import type {
  RecorderWorkerRequest,
  RecorderWorkerResponse,
} from './recorder-worker-protocol'

/**
 * Dedicated-worker MediaRecorder. Encoded chunks stay here until stop so
 * the page's main thread never handles ondataavailable during a take.
 *
 * Typed against a narrow worker scope so this file can live in the app
 * tsconfig (DOM + Worker libs conflict on `self`).
 */

interface RecorderWorkerScope {
  onmessage: ((event: MessageEvent<RecorderWorkerRequest>) => void) | null
  postMessage: (message: RecorderWorkerResponse, transfer?: Transferable[]) => void
}

interface WorkerSession {
  recorder: MediaRecorder
  stream: MediaStream
  videoTracks: MediaStreamTrack[]
  audioTracks: MediaStreamTrack[]
  chunks: Blob[]
}

const sessions = new Map<string, WorkerSession>()

const worker = self as unknown as RecorderWorkerScope

function post(message: RecorderWorkerResponse, transfer: Transferable[] = []): void {
  worker.postMessage(message, transfer)
}

function liveAudioTracks(session: WorkerSession): MediaStreamTrack[] {
  return session.audioTracks.filter((track) => track.readyState === 'live')
}

function stopVideoTracks(session: WorkerSession): void {
  session.videoTracks.forEach((track) => {
    track.stop()
  })
}

function bindTrackEnded(sessionId: string, tracks: MediaStreamTrack[]): void {
  const onEnded = () => {
    post({ type: 'track-ended', sessionId })
  }
  tracks.forEach((track) => {
    track.addEventListener('ended', onEnded, { once: true })
  })
}

function openSession(request: Extract<RecorderWorkerRequest, { type: 'open' }>): void {
  if (typeof MediaRecorder === 'undefined') {
    post(
      {
        type: 'error',
        requestId: request.requestId,
        sessionId: request.sessionId,
        message: 'MediaRecorder is not available in this worker',
        tracks: request.tracks,
      },
      request.tracks,
    )
    return
  }

  const videoTracks = request.tracks.filter((track) => track.kind === 'video')
  const audioTracks = request.tracks.filter((track) => track.kind === 'audio')
  const stream = new MediaStream(request.tracks)
  const chunks: Blob[] = []

  try {
    const recorder = request.mimeType
      ? new MediaRecorder(stream, {
          mimeType: request.mimeType,
          videoBitsPerSecond: request.videoBitsPerSecond,
          audioBitsPerSecond: request.audioBitsPerSecond,
        })
      : new MediaRecorder(stream)
    const session: WorkerSession = {
      recorder,
      stream,
      videoTracks,
      audioTracks,
      chunks,
    }
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onerror = () => {
      // Stop is the caller's job — they already own teardown. Surface the
      // failure so a take waiting on stop/cancel is not left hanging.
      post({
        type: 'error',
        requestId: request.requestId,
        sessionId: request.sessionId,
        message: 'Recording failed',
        tracks: [],
      })
    }
    bindTrackEnded(request.sessionId, request.tracks)
    recorder.start()
    sessions.set(request.sessionId, session)
    post({
      type: 'opened',
      requestId: request.requestId,
      sessionId: request.sessionId,
      mimeType: recorder.mimeType || request.mimeType || 'video/webm',
    })
  } catch (error) {
    videoTracks.forEach((track) => {
      track.stop()
    })
    post(
      {
        type: 'error',
        requestId: request.requestId,
        sessionId: request.sessionId,
        message: error instanceof Error ? error.message : 'Could not start recorder',
        tracks: audioTracks,
      },
      audioTracks,
    )
  }
}

function finishRecorder(
  session: WorkerSession,
  then: () => void,
): void {
  if (session.recorder.state === 'inactive') {
    then()
    return
  }
  session.recorder.onstop = then
  session.recorder.onerror = then
  try {
    session.recorder.stop()
  } catch {
    then()
  }
}

function stopSession(request: Extract<RecorderWorkerRequest, { type: 'stop' }>): void {
  const session = sessions.get(request.sessionId)
  if (!session) {
    post({
      type: 'error',
      requestId: request.requestId,
      sessionId: request.sessionId,
      message: 'No live recording session',
      tracks: [],
    })
    return
  }
  sessions.delete(request.sessionId)
  finishRecorder(session, () => {
    stopVideoTracks(session)
    const blob = new Blob(session.chunks, { type: session.recorder.mimeType || 'video/webm' })
    const audioTracks = liveAudioTracks(session)
    post(
      {
        type: 'stopped',
        requestId: request.requestId,
        sessionId: request.sessionId,
        blob,
        mimeType: session.recorder.mimeType || blob.type || 'video/webm',
        audioTracks,
      },
      audioTracks,
    )
  })
}

function cancelSession(request: Extract<RecorderWorkerRequest, { type: 'cancel' }>): void {
  const session = sessions.get(request.sessionId)
  if (!session) {
    post({
      type: 'canceled',
      requestId: request.requestId,
      sessionId: request.sessionId,
      audioTracks: [],
    })
    return
  }
  sessions.delete(request.sessionId)
  session.recorder.ondataavailable = null
  finishRecorder(session, () => {
    stopVideoTracks(session)
    const audioTracks = liveAudioTracks(session)
    post(
      {
        type: 'canceled',
        requestId: request.requestId,
        sessionId: request.sessionId,
        audioTracks,
      },
      audioTracks,
    )
  })
}

worker.onmessage = (event: MessageEvent<RecorderWorkerRequest>) => {
  const request = event.data
  switch (request.type) {
    case 'ping':
      post({
        type: 'pong',
        requestId: request.requestId,
        mediaRecorder: typeof MediaRecorder !== 'undefined',
      })
      return
    case 'open':
      openSession(request)
      return
    case 'stop':
      stopSession(request)
      return
    case 'cancel':
      cancelSession(request)
      return
    default: {
      const _exhaustive: never = request
      return _exhaustive
    }
  }
}
