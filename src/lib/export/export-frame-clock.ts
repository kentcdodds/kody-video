export const EXPORT_FPS = 30
export const EXPORT_FRAME_INTERVAL_SEC = 1 / EXPORT_FPS

/**
 * Drop only frames earlier than half a tick before the next grid time.
 * Jittery 30fps (intervals ~21ms) stays; 60fps extras (~16.7ms) go.
 * The previous 0.3/FPS (10ms) tolerance was the source of the 66.7ms
 * skips on Android MediaRecorder timestamps.
 */
export const EXPORT_EARLY_TOLERANCE_SEC = 0.45 / EXPORT_FPS

export interface ExportFrameClock {
  /** Next 30fps output-clock tick. */
  nextFrameTsSec: number
  /** Last timestamp handed to the encoder; -1 before the first frame. */
  lastVideoTsSec: number
}

export interface ExportFramePlan {
  /** Repeat the already-drawn canvas this many 30fps ticks before drawing. */
  holdTicks: number
  /** Timestamp for the new source frame (on the 30fps grid after the first). */
  emitTsSec: number
  nextFrameTsSec: number
}

/**
 * Decide whether to emit a source frame and how many held ticks to insert
 * so a gap becomes a freeze, not a timestamp jump.
 */
export function planExportFrame(
  clock: ExportFrameClock,
  tsSec: number,
  options?: { force?: boolean },
): ExportFramePlan | null {
  if (!options?.force && tsSec < clock.nextFrameTsSec - EXPORT_EARLY_TOLERANCE_SEC) {
    return null
  }

  if (clock.lastVideoTsSec < 0) {
    const emitTsSec = Math.max(0, tsSec)
    return {
      holdTicks: 0,
      emitTsSec,
      nextFrameTsSec: emitTsSec + EXPORT_FRAME_INTERVAL_SEC,
    }
  }

  let holdTicks = 0
  let tick = clock.nextFrameTsSec
  while (tick + EXPORT_FRAME_INTERVAL_SEC <= tsSec + 1e-9) {
    holdTicks += 1
    tick += EXPORT_FRAME_INTERVAL_SEC
  }

  return {
    holdTicks,
    emitTsSec: tick,
    nextFrameTsSec: tick + EXPORT_FRAME_INTERVAL_SEC,
  }
}
