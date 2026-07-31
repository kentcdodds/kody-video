/**
 * Decode-driven export probe: seeds a project with real H.264 MP4 clips
 * (generated with ffmpeg into /tmp), exports, and asserts the export runs
 * meaningfully FASTER than realtime — the element-pump path is paced at 1×
 * playback, so wall time below total clip duration proves the VideoDecoder
 * pipeline carried the frames.
 * Run: node scripts/probe-fast-export.mjs   (starts its own vite dev server)
 */
import { chromium } from 'playwright'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4191
const BASE = `http://127.0.0.1:${PORT}`
const CLIP_SECONDS = 4
// One clip per rate: the export must decimate every source rate to the
// 30fps output budget instead of encoding extra frames at fewer bits each.
// 40fps matters specifically — a naive minimum-gap decimator caps 60/120fps
// but waves 40fps straight through.
const CLIP_RATES = [30, 60, 40, 60]
const CLIP_COUNT = CLIP_RATES.length
// Cache key carries the fixture parameters so edits never reuse stale files.
const clipPath = (rate) => `/tmp/kv-test-clip-${rate}fps-${CLIP_SECONDS}s-360x640.mp4`

for (const rate of new Set(CLIP_RATES)) {
  if (existsSync(clipPath(rate))) continue
  execFileSync('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=360x640:rate=${rate}:duration=${CLIP_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${CLIP_SECONDS}:sample_rate=48000`,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', clipPath(rate),
  ])
}

// Dev server: probes that import /src modules in-page need vite transforms.
const dev = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})
async function waitForServer(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server not ready')
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  await waitForServer(BASE)
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()
  for (const rate of new Set(CLIP_RATES)) {
    await page.route(`**/__test-clip-${rate}.mp4`, (route) => route.fulfill({ path: clipPath(rate) }))
  }
  const warnings = []
  page.on('console', (msg) => {
    // Any fallback defeats the probe's purpose: the whole-export realtime
    // stitcher, a per-clip element pump, or an encoder failure.
    if (/falling back to realtime|segment video path: element|encoder failure/i.test(msg.text())) {
      warnings.push(msg.text())
    }
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })

  // Seed a project with MP4 clips straight into IndexedDB.
  await page.evaluate(
    async ({ rates, clipMs }) => {
      const { createProject, addClip, setOnboardingDismissed } = await import('/src/lib/storage.ts')
      await setOnboardingDismissed(true)
      const project = await createProject('Fast export probe')
      const blobs = new Map()
      for (const rate of rates) {
        if (!blobs.has(rate)) {
          const blob = await (await fetch(`/__test-clip-${rate}.mp4`)).blob()
          blobs.set(rate, new Blob([blob], { type: 'video/mp4' }))
        }
        await addClip({
          projectId: project.id,
          blob: blobs.get(rate),
          mimeType: 'video/mp4',
          durationMs: clipMs,
          width: 360,
          height: 640,
        })
      }
      return project.id
    },
    { rates: CLIP_RATES, clipMs: CLIP_SECONDS * 1000 },
  )

  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.project-slot.filled .slot-open').first().click()
  await page.waitForURL(/\/project\//)
  await page.waitForSelector('.record-stage video')

  const totalSeconds = CLIP_SECONDS * CLIP_COUNT
  const startedAt = Date.now()
  await page.locator('.go-button').click()
  await page.waitForSelector('.export-sheet, [class*=export]', { timeout: 10_000 }).catch(() => null)
  await page.getByText(/your video is ready/i).waitFor({ timeout: totalSeconds * 2 * 1000 })
  const elapsedSeconds = (Date.now() - startedAt) / 1000

  check(
    `export of ${totalSeconds}s finished in ${elapsedSeconds.toFixed(1)}s`,
    elapsedSeconds < totalSeconds * 0.75,
    'decode-driven pump must beat realtime',
  )
  check('no realtime-engine fallback occurred', warnings.length === 0, warnings.join(' | '))

  // The output must be a real, playable file (streamed to OPFS where
  // available): download it and let ffprobe be the judge.
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
  await page.getByRole('button', { name: /^save$/i }).click()
  const download = await downloadPromise
  const savedPath = '/tmp/kv-fast-export-out'
  await download.saveAs(savedPath)
  // -count_frames: decode and count REAL frames — avg_frame_rate reflects
  // the declared track rate, which would hide frame-rate inflation.
  const probeOut = spawnSync(
    'ffprobe',
    [
      '-v', 'error', '-count_frames',
      '-show_entries', 'format=duration:stream=codec_type,nb_read_frames',
      '-of', 'json', savedPath,
    ],
    { encoding: 'utf8' },
  )
  let streams = []
  let duration = 0
  let videoFps = 0
  try {
    const parsed = JSON.parse(probeOut.stdout)
    streams = (parsed.streams ?? []).map((s) => s.codec_type)
    duration = Number(parsed.format?.duration ?? 0)
    const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video')
    const frames = Number(video?.nb_read_frames ?? 0)
    videoFps = duration > 0 ? frames / duration : 0
  } catch {}
  check(
    `output has video+audio and ~${totalSeconds}s duration`,
    streams.includes('video') && streams.includes('audio') && Math.abs(duration - totalSeconds) < 1.5,
    `streams=${streams.join(',')} duration=${duration.toFixed(2)}s`,
  )
  check(
    `${CLIP_RATES.join('/')}fps sources are decimated to ~30fps output (${videoFps.toFixed(1)}fps decoded)`,
    videoFps > 26 && videoFps < 31.5,
    'frame-rate inflation cuts bits-per-frame',
  )

  // Recovery: close the sheet, tap Go again — the persisted last export
  // must come back instantly instead of re-encoding.
  await page.getByRole('button', { name: /^done$/i }).click()
  const recoverStartedAt = Date.now()
  await page.locator('.go-button').click()
  await page.getByText(/restored your last export/i).waitFor({ timeout: 5_000 })
  const recoverSeconds = (Date.now() - recoverStartedAt) / 1000
  check(
    `missed-share recovery is instant (${recoverSeconds.toFixed(1)}s)`,
    recoverSeconds < 3,
  )

  // Clips ZIP: one archive with every original clip inside.
  const zipDownloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: /save original clips/i }).click()
  const zipDownload = await zipDownloadPromise
  const zipPath = '/tmp/kv-clips-out.zip'
  await zipDownload.saveAs(zipPath)
  const zipList = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' })
  const entryCount = (zipList.stdout.match(/\.mp4|\.webm/g) ?? []).length
  check(
    `clips zip contains all ${CLIP_COUNT} clips`,
    zipList.status === 0 && entryCount === CLIP_COUNT,
    `entries=${entryCount}`,
  )

  await browser.close()
} catch (err) {
  check('probe crashed', false, String(err))
} finally {
  dev.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
