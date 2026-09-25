/**
 * Capture-cadence probe: records real hold-to-record takes in Chromium with
 * a fake 30fps camera, then reads every saved clip's video timestamps
 * (metadata-only demux) and lines them up with main-thread long tasks and
 * event-loop lag measured during each hold.
 *
 * Scenarios:
 *   baseline      one take on an idle record screen
 *   zoom-drag     one take with a continuous drag-to-zoom sweep (zoom range
 *                 shimmed onto the fake camera) — counts applyConstraints
 *   back-to-back  a take that starts right after another take released, in a
 *                 project that already holds many clips (post-take save +
 *                 hydrate work lands inside the second hold)
 *   jank          one take while an injected loop blocks the main thread
 *                 (--jank=blockMs:periodMs, default 250:500) — does a
 *                 main-thread stall alone drop recorded frames?
 *
 * Each take also prints the app's own take report (lib/take-report.ts),
 * so the production telemetry can be checked against ground truth.
 *
 * Run: node scripts/probe-capture-cadence.mjs [--throttle=4] [--scenario=back-to-back]
 *      [--seed=20] [--hold=4000] [--out=/tmp/cadence.json] [--base=http://127.0.0.1:5173]
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=')
    return [key, value ?? 'true']
  }),
)
const THROTTLE = Number(args.throttle ?? 1)
const SEED = Number(args.seed ?? 20)
const HOLD_MS = Number(args.hold ?? 4000)
const SCENARIOS = (args.scenario ?? 'baseline,zoom-drag,back-to-back,jank').split(',')
const PORT = Number(args.port ?? 4191)
const BASE = `http://127.0.0.1:${PORT}`

const server = args.base
  ? null
  : spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
const base = args.base ?? BASE

async function waitForServer(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server not ready')
}

/** Main-thread observers installed before any app code runs. */
function installPageProbes() {
  window.__kvLongTasks = []
  window.__kvLag = []
  window.__kvApplyConstraints = 0
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__kvLongTasks.push({ start: entry.startTime, duration: entry.duration })
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch {}
  let expected = performance.now() + 50
  setInterval(() => {
    const now = performance.now()
    const late = now - expected
    if (late > 30) window.__kvLag.push({ at: expected, lateMs: late })
    expected = now + 50
  }, 50)
  const apply = MediaStreamTrack.prototype.applyConstraints
  MediaStreamTrack.prototype.applyConstraints = function (...rest) {
    window.__kvApplyConstraints += 1
    return apply.apply(this, rest)
  }
  window.__kvEvents = []
  const logEvent = (name) => window.__kvEvents.push({ name, at: performance.now() })
  const start = MediaRecorder.prototype.start
  MediaRecorder.prototype.start = function (...rest) {
    logEvent(`recorder.start:${this.stream.getAudioTracks().length ? 'av' : 'v'}`)
    return start.apply(this, rest)
  }
  const createSource = AudioContext.prototype.createMediaStreamSource
  AudioContext.prototype.createMediaStreamSource = function (...rest) {
    logEvent('audio.createMediaStreamSource')
    return createSource.apply(this, rest)
  }
  const resume = AudioContext.prototype.resume
  AudioContext.prototype.resume = function (...rest) {
    logEvent(`audio.resume:${this.state}`)
    return resume.apply(this, rest)
  }
}

/** The fake camera exposes no zoom range — shim one so drag-to-zoom engages. */
function installZoomShim() {
  const original = MediaStreamTrack.prototype.getCapabilities
  MediaStreamTrack.prototype.getCapabilities = function () {
    const caps = original ? original.call(this) : {}
    if (this.kind === 'video') caps.zoom = { min: 1, max: 8, step: 0.1 }
    return caps
  }
}

async function newPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()
  await page.addInitScript(installPageProbes)
  if (options.zoomShim) await page.addInitScript(installZoomShim)
  if (THROTTLE > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  }
  await page.goto(base)
  await page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    await storage.setOnboardingDismissed(true)
  })
  return page
}

async function seedProject(page, clips) {
  return page.evaluate(async (count) => {
    const storage = await import('/src/lib/storage.ts')
    const thumbs = await import('/src/lib/thumbs.ts')
    const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
    const project = await storage.createProject('Cadence probe')
    const blob = await makeTestClipBlob(1500)
    for (let i = 0; i < count; i += 1) {
      const clip = await storage.addClip({
        projectId: project.id,
        blob,
        mimeType: 'video/webm',
        durationMs: 1500,
        width: 320,
        height: 568,
      })
      await thumbs.ensureClipThumbs(clip)
    }
    return project.id
  }, clips)
}

async function openCamera(page, path) {
  await page.goto(`${base}${path}`)
  await page.waitForFunction(() => {
    const video = document.querySelector('.camera-video')
    return video && video.readyState >= 2 && !video.paused
  })
  // Let the idle warm-up (encoder arm, mic-monitor context) settle.
  await sleep(2500)
}

async function clipCount(page) {
  return page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    let total = 0
    for (const project of await storage.listProjects()) {
      total += (await storage.getClipMetasForProject(project.id)).length
    }
    return total
  })
}

async function hold(page, holdMs, during) {
  const box = await page.locator('.record-stage').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.locator('.record-pill').waitFor({ timeout: 5000 })
  const startedAt = await page.evaluate(() => performance.now())
  if (during) await during()
  await sleep(holdMs)
  const endedAt = await page.evaluate(() => performance.now())
  await page.mouse.up()
  return { startedAt, endedAt }
}

async function mainThreadDuring(page, window) {
  return page.evaluate(({ startedAt, endedAt }) => {
    const inWindow = (start, end) => end > startedAt && start < endedAt
    const longTasks = window.__kvLongTasks.filter((task) =>
      inWindow(task.start, task.start + task.duration),
    )
    const lag = window.__kvLag.filter((sample) => sample.at > startedAt && sample.at < endedAt)
    const events = window.__kvEvents
      .filter((event) => event.at > startedAt - 3000 && event.at < endedAt)
      .map((event) => `${event.name}@${Math.round(event.at - startedAt)}ms`)
    return {
      events,
      longTasks: longTasks.length,
      longTaskMs: Math.round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
      maxLongTaskMs: Math.round(Math.max(0, ...longTasks.map((task) => task.duration))),
      lagSamplesOver30ms: lag.length,
      maxLagMs: Math.round(Math.max(0, ...lag.map((sample) => sample.lateMs))),
    }
  }, window)
}

async function analyzeClips(page) {
  return page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    const cadence = await import('/src/lib/take-cadence.ts')
    const results = []
    for (const project of await storage.listProjects()) {
      for (const clip of await storage.getClipsForProject(project.id)) {
        if (clip.mimeType === 'video/webm' && clip.durationMs === 1500) continue
        const stamps = await cadence.readTakeTimestamps(clip.blob)
        const kept = cadence.analyzeFrameCadence(stamps.videoSec, {
          startMs: clip.trimStartMs,
          endMs: clip.trimEndMs,
        })
        const whole = cadence.analyzeFrameCadence(stamps.videoSec)
        results.push({
          clipId: clip.id,
          createdAt: clip.createdAt,
          mimeType: clip.mimeType,
          durationMs: clip.durationMs,
          trim: [clip.trimStartMs, clip.trimEndMs],
          codec: stamps.videoCodec,
          kept,
          wholeFile: {
            frames: whole.frames,
            fps: whole.fps,
            droppedFrames: whole.droppedFrames,
            firstVideoMs: Math.round((Math.min(...stamps.videoSec) || 0) * 1000),
          },
          audio: cadence.analyzeAudioContinuity(stamps.audio),
        })
      }
    }
    return results.sort((a, b) => a.createdAt - b.createdAt)
  })
}

/** The app's own take reports (lib/capture-diagnostics.ts), once analyzed. */
async function takeReports(page, count) {
  for (let i = 0; i < 60; i++) {
    // Builds without take reports (before/after comparisons) return null.
    const reports = await page.evaluate(async () => {
      try {
        const diagnostics = await import('/src/lib/capture-diagnostics.ts')
        return await diagnostics.listTakeReports()
      } catch {
        return null
      }
    })
    if (!reports) return []
    if (reports.filter((report) => report.cadence).length >= count) {
      return reports.reverse().map((report) => ({
        verdict: report.verdict,
        reasons: report.reasons,
        fps: report.cadence?.fps,
        dropped: report.cadence?.droppedFrames,
        gaps: report.gaps,
        stalls: report.live.mainThread.stalls,
        zoom: report.live.zoom,
        encoder: report.encoder,
        saveMs: report.saveMs,
        backgroundWork: report.live.backgroundWork,
        previousSaveInFlight: report.env.previousSaveInFlight,
      }))
    }
    await sleep(500)
  }
  return []
}

async function waitForClips(page, count) {
  for (let i = 0; i < 80; i++) {
    if ((await clipCount(page)) >= count) return
    await sleep(250)
  }
  throw new Error(`expected ${count} clips`)
}

const scenarios = {
  async baseline(browser) {
    const page = await newPage(browser)
    await openCamera(page, '/project/new')
    const take = await hold(page, HOLD_MS)
    await waitForClips(page, 1)
    await sleep(1500)
    const mainThread = await mainThreadDuring(page, take)
    const clips = await analyzeClips(page)
    const [report] = await takeReports(page, 1)
    await page.context().close()
    return { takes: [{ mainThread, cadence: clips[0], report }] }
  },

  async 'zoom-drag'(browser) {
    const page = await newPage(browser, { zoomShim: true })
    await openCamera(page, '/project/new')
    const box = await page.locator('.record-stage').boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const applyBefore = await page.evaluate(() => window.__kvApplyConstraints)
    const take = await hold(page, HOLD_MS, () => {
      void (async () => {
        const end = Date.now() + HOLD_MS - 300
        let i = 0
        while (Date.now() < end) {
          // Sweep up and down across ~40% of the stage, like a thumb.
          const offset = Math.sin(i / 12) * box.height * 0.2 - 30
          await page.mouse.move(x, y + offset)
          i += 1
          await sleep(4)
        }
      })()
    })
    const applyDuring = (await page.evaluate(() => window.__kvApplyConstraints)) - applyBefore
    await waitForClips(page, 1)
    await sleep(1500)
    const mainThread = await mainThreadDuring(page, take)
    const clips = await analyzeClips(page)
    const [report] = await takeReports(page, 1)
    await page.context().close()
    return { takes: [{ mainThread: { ...mainThread, applyConstraints: applyDuring }, cadence: clips[0], report }] }
  },

  async 'back-to-back'(browser) {
    const page = await newPage(browser)
    const projectId = await seedProject(page, SEED)
    await openCamera(page, `/project/${projectId}`)
    // Let the load-time hydrate (audio peaks for the seeded clips) finish.
    await sleep(4000)
    const takeA = await hold(page, 1500)
    await sleep(250)
    const takeB = await hold(page, HOLD_MS)
    await waitForClips(page, SEED + 2)
    await sleep(2500)
    const mainA = await mainThreadDuring(page, takeA)
    const mainB = await mainThreadDuring(page, takeB)
    const clips = await analyzeClips(page)
    const [reportA, reportB] = await takeReports(page, 2)
    await page.context().close()
    return {
      takes: [
        { label: 'A (idle screen)', mainThread: mainA, cadence: clips[0], report: reportA },
        { label: 'B (right after A)', mainThread: mainB, cadence: clips[1], report: reportB },
      ],
    }
  },

  async jank(browser) {
    const [blockMs, periodMs] = (args.jank ?? '250:500').split(':').map(Number)
    const page = await newPage(browser)
    await openCamera(page, '/project/new')
    const take = await hold(page, HOLD_MS, () =>
      page.evaluate(
        ({ holdMs, blockMs, periodMs }) => {
          const until = performance.now() + holdMs
          const block = () => {
            const end = performance.now() + blockMs
            while (performance.now() < end) {
              // Busy main thread, like a heavy post-take parse or GC.
            }
            if (performance.now() < until) setTimeout(block, Math.max(0, periodMs - blockMs))
          }
          setTimeout(block, 100)
        },
        { holdMs: HOLD_MS, blockMs, periodMs },
      ),
    )
    await waitForClips(page, 1)
    await sleep(1500)
    const mainThread = await mainThreadDuring(page, take)
    const clips = await analyzeClips(page)
    const [report] = await takeReports(page, 1)
    await page.context().close()
    return { takes: [{ mainThread, cadence: clips[0], report }] }
  },
}

const report = { throttle: THROTTLE, holdMs: HOLD_MS, seed: SEED, scenarios: {} }
try {
  if (server) await waitForServer(base)
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream=fps=30',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  for (const name of SCENARIOS) {
    const run = scenarios[name]
    if (!run) throw new Error(`unknown scenario ${name}`)
    report.scenarios[name] = await run(browser)
    for (const take of report.scenarios[name].takes) {
      const kept = take.cadence?.kept
      console.log(
        [
          name.padEnd(13),
          (take.label ?? '').padEnd(18),
          `fps ${kept?.fps}`,
          `dropped ${kept?.droppedFrames}/${kept?.expectedFrames}`,
          `maxGap ${kept?.maxGapMs}ms`,
          `stalls ${kept?.stalls}`,
          `head ${kept?.headGapMs}ms`,
          `| longTasks ${take.mainThread.longTasks} (${take.mainThread.longTaskMs}ms, max ${take.mainThread.maxLongTaskMs})`,
          `maxLag ${take.mainThread.maxLagMs}ms`,
          take.mainThread.applyConstraints !== undefined
            ? `applyConstraints ${take.mainThread.applyConstraints}`
            : '',
        ].join('  '),
      )
      if (take.report) {
        const r = take.report
        console.log(
          `${''.padEnd(33)}app report: ${r.verdict} [${r.reasons.join(', ')}] zoom ${r.zoom.requested} requested / ${r.zoom.applied} applied, warm ${r.encoder?.warmAgeMs}ms, flush ${r.encoder?.flushMs}ms, save ${r.saveMs}ms, track frames ${JSON.stringify(r.encoder?.trackFrames)}`,
        )
      }
    }
  }
  await browser.close()
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2))
} finally {
  server?.kill()
}
