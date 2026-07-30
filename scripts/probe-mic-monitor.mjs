/**
 * Silent-mic warning probe: recording with a silent fake mic must show the
 * "Mic isn't picking up sound" pill; Chromium's default fake mic (a tone)
 * must not. Run: npm run build && node scripts/probe-mic-monitor.mjs
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4188
const BASE = `http://127.0.0.1:${PORT}`
const preview = spawn(
  'npm',
  ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
)
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server not ready')
}

/** 6s mono 48kHz 16-bit PCM WAV: silence, or a clearly audible 440Hz tone.
 * (Chromium's DEFAULT fake mic peaks at ~0.003 — below the app's real-mic
 * floor — so the control needs an explicit tone fixture.) */
function writeWav(path, { tone }) {
  const sampleRate = 48000
  const seconds = 6
  const sampleCount = sampleRate * seconds
  const buffer = Buffer.alloc(44 + sampleCount * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + sampleCount * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(sampleCount * 2, 40)
  if (tone) {
    for (let i = 0; i < sampleCount; i++) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3 * 32767)
      buffer.writeInt16LE(value, 44 + i * 2)
    }
  }
  writeFileSync(path, buffer)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function pillDuringTake(extraArgs) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...extraArgs],
  })
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForURL(/\/project\//)
  const ob = page.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) await page.getByRole('button', { name: /start recording/i }).click()
  await page.waitForFunction(() => {
    const v = document.querySelector('.record-stage video')
    return v && v.videoWidth > 0
  })
  // Hold well past the monitor's 2.5s grace period.
  await page.keyboard.down('Space')
  await sleep(4200)
  const pill = await page
    .getByText(/mic isn.t picking up sound/i)
    .isVisible()
    .catch(() => false)
  await page.keyboard.up('Space')
  await sleep(800)
  await browser.close()
  return pill
}

try {
  await waitForServer(BASE)
  writeWav('/tmp/kv-silence.wav', { tone: false })
  writeWav('/tmp/kv-tone.wav', { tone: true })

  const silentPill = await pillDuringTake([
    '--use-file-for-fake-audio-capture=/tmp/kv-silence.wav',
  ])
  check('silent mic shows the warning pill during the take', silentPill)

  const tonePill = await pillDuringTake(['--use-file-for-fake-audio-capture=/tmp/kv-tone.wav'])
  check('audible mic shows no warning', !tonePill)
} catch (err) {
  check('probe crashed', false, String(err))
} finally {
  preview.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
