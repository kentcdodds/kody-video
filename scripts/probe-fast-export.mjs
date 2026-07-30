/**
 * Decode-driven export probe: seeds a project with real H.264 MP4 clips
 * (generated with ffmpeg into /tmp), exports, and asserts the export runs
 * meaningfully FASTER than realtime — the element-pump path is paced at 1×
 * playback, so wall time below total clip duration proves the VideoDecoder
 * pipeline carried the frames.
 * Run: node scripts/probe-fast-export.mjs   (starts its own vite dev server)
 */
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4191
const BASE = `http://127.0.0.1:${PORT}`
const CLIP_PATH = '/tmp/kv-test-clip.mp4'
const CLIP_SECONDS = 4
const CLIP_COUNT = 4

if (!existsSync(CLIP_PATH)) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=360x640:rate=30:duration=${CLIP_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${CLIP_SECONDS}:sample_rate=48000`,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', CLIP_PATH,
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
  await page.route('**/__test-clip.mp4', (route) => route.fulfill({ path: CLIP_PATH }))
  const warnings = []
  page.on('console', (msg) => {
    if (/falling back to realtime|encoder failure/i.test(msg.text())) warnings.push(msg.text())
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })

  // Seed a project with MP4 clips straight into IndexedDB.
  await page.evaluate(
    async ({ clipCount, clipMs }) => {
      const { createProject, addClip, setOnboardingDismissed } = await import('/src/lib/storage.ts')
      await setOnboardingDismissed(true)
      const project = await createProject('Fast export probe')
      const blob = await (await fetch('/__test-clip.mp4')).blob()
      const mp4 = new Blob([blob], { type: 'video/mp4' })
      for (let i = 0; i < clipCount; i += 1) {
        await addClip({
          projectId: project.id,
          blob: mp4,
          mimeType: 'video/mp4',
          durationMs: clipMs,
          width: 360,
          height: 640,
        })
      }
      return project.id
    },
    { clipCount: CLIP_COUNT, clipMs: CLIP_SECONDS * 1000 },
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

  await browser.close()
} catch (err) {
  check('probe crashed', false, String(err))
} finally {
  dev.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
