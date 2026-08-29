/**
 * Messages between HoldRecorder and the dedicated recorder worker.
 *
 * MediaRecorder + encoded chunks live in the worker so mid-take UI work
 * (Remix updates, zoom, mic-level warning) cannot starve the encoder's
 * event loop. Tracks arrive via the structured-clone transfer list.
 */

export interface RecorderOpenRequest {
  type: 'open'
  requestId: number
  sessionId: string
  mimeType: string
  videoBitsPerSecond: number
  audioBitsPerSecond: number
  /** Video clones + the live mic originals. Transferred, not copied. */
  tracks: MediaStreamTrack[]
}

export interface RecorderStopRequest {
  type: 'stop'
  requestId: number
  sessionId: string
}

export interface RecorderCancelRequest {
  type: 'cancel'
  requestId: number
  sessionId: string
}

export interface RecorderPingRequest {
  type: 'ping'
  requestId: number
}

export type RecorderWorkerRequest =
  | RecorderOpenRequest
  | RecorderStopRequest
  | RecorderCancelRequest
  | RecorderPingRequest

export interface RecorderOpenedResponse {
  type: 'opened'
  requestId: number
  sessionId: string
  mimeType: string
}

export interface RecorderStoppedResponse {
  type: 'stopped'
  requestId: number
  sessionId: string
  blob: Blob
  mimeType: string
  /** Live mic originals come back so the camera can release them. */
  audioTracks: MediaStreamTrack[]
}

export interface RecorderCanceledResponse {
  type: 'canceled'
  requestId: number
  sessionId: string
  audioTracks: MediaStreamTrack[]
}

export interface RecorderErrorResponse {
  type: 'error'
  requestId: number
  sessionId: string
  message: string
  /** Tracks the worker still holds after a failed open, if any. */
  tracks: MediaStreamTrack[]
}

export interface RecorderPongResponse {
  type: 'pong'
  requestId: number
  mediaRecorder: boolean
}

export interface RecorderTrackEndedResponse {
  type: 'track-ended'
  sessionId: string
}

export type RecorderWorkerResponse =
  | RecorderOpenedResponse
  | RecorderStoppedResponse
  | RecorderCanceledResponse
  | RecorderErrorResponse
  | RecorderPongResponse
  | RecorderTrackEndedResponse

export function isRecorderWorkerResponse(value: unknown): value is RecorderWorkerResponse {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'opened' ||
    type === 'stopped' ||
    type === 'canceled' ||
    type === 'error' ||
    type === 'pong' ||
    type === 'track-ended'
  )
}
