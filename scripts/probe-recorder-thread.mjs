/**
 * Does main-thread load drop frames in a MediaRecorder take?
 *
 * Chrome cannot transfer camera tracks into a worker, so moving
 * MediaRecorder off-thread is not available for capture. This probe
 * records the same fake-camera stream twice — idle vs jammed main
 * thread — and compares decoded frame counts.
 *
 * Run: node scripts/probe-recorder-thread.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const HOLD_MS = 3000
const JANK_BLOCK_MS = 18
const JANK_PERIOD_MS = 33

const pageHtml = `<!doctype html>
<meta charset="utf-8" />
<title>recorder jank probe</title>
<script>
function jankMainThread(durationMs) {
  const endAt = performance.now() + durationMs
  let timer = 0
  const tick = () => {
    if (performance.now() >= endAt) return
    const until = performance.now() + ${JANK_BLOCK_MS}
    while (performance.now() < until) {}
    timer = window.setTimeout(tick, ${JANK_PERIOD_MS - JANK_BLOCK_MS})
  }
  tick()
  return () => window.clearTimeout(timer)
}

async function recordOnce(stream, holdMs, jank) {
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : ''
  const recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 })
    : new MediaRecorder(stream)
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const stopJank = jank ? jankMainThread(holdMs + 200) : () => {}
  recorder.start()
  await new Promise((r) => setTimeout(r, holdMs))
  const blob = await new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }))
    recorder.onerror = () => reject(new Error('MediaRecorder failed'))
    recorder.stop()
  })
  stopJank()
  return decodeFrameCount(blob)
}

async function decodeFrameCount(blob) {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve
    video.onerror = () => reject(new Error('decode failed'))
  })
  let frames = 0
  const done = new Promise((resolve) => {
    video.onended = () => resolve()
    video.onerror = () => resolve()
  })
  const onFrame = () => {
    frames += 1
    if (!video.ended) video.requestVideoFrameCallback(onFrame)
  }
  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(onFrame)
  }
  await video.play()
  await Promise.race([done, new Promise((r) => setTimeout(r, 8000))])
  URL.revokeObjectURL(url)
  const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0
  return {
    blobSize: blob.size,
    durationMs,
    decodedFrames: frames,
    fps: durationMs > 0 ? (frames / durationMs) * 1000 : 0,
  }
}

window.__runProbe = async () => {
  const holdMs = ${HOLD_MS}
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, frameRate: 30 },
    audio: true,
  })
  try {
    const idle = await recordOnce(stream, holdMs, false)
    const jammed = await recordOnce(stream, holdMs, true)
    return { holdMs, idle, jammed }
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}
</script>
`

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(pageHtml)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error('pageerror', err))
  await page.goto(`http://127.0.0.1:${port}/`)
  const result = await page.evaluate(() => window.__runProbe())
  console.log(JSON.stringify(result, null, 2))
  const frameDrop = result.idle.decodedFrames - result.jammed.decodedFrames
  const fpsDrop = result.idle.fps - result.jammed.fps
  const durationDrop = result.idle.durationMs - result.jammed.durationMs
  const mainThreadHurts = frameDrop >= 8 || fpsDrop >= 2 || durationDrop >= 200
  const verdict = mainThreadHurts ? 'MAIN_THREAD_HURTS' : 'NO_MAIN_THREAD_EFFECT'
  console.log(
    `VERDICT: ${verdict} frameDrop=${frameDrop} fpsDrop=${fpsDrop.toFixed(2)} durationDrop=${durationDrop}`,
  )
  writeFileSync(
    '/opt/cursor/artifacts/recorder_thread_bench.json',
    `${JSON.stringify({ verdict, ...result }, null, 2)}\n`,
  )
  process.exitCode = mainThreadHurts ? 0 : 3
} finally {
  await browser.close()
  server.close()
}
