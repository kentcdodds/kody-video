import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import type { BrowserCommand } from 'vitest/node'

/**
 * Vitest browser-mode command: tests run inside Chromium, but ffmpeg
 * validation needs a real binary and filesystem, so this half executes on
 * the Vitest server (Node) and the test calls it via `commands`.
 */

const PLAYWRIGHT_FFMPEG = '/home/ubuntu/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux'

function resolveFfmpeg(): string | null {
  const candidates = [PLAYWRIGHT_FFMPEG, 'ffmpeg', '/usr/bin/ffmpeg']
  for (const bin of candidates) {
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    try {
      // Playwright's ffmpeg build is VP8/WebM-only; probe MP4 demux support.
      const help = execFileSync(bin, ['-hide_banner', '-demuxers'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (/\bmov\b|\bmp4\b/i.test(help)) return bin
    } catch {
      // try next
    }
  }
  // Spec asks us to skip when the playwright binary is missing; if it exists
  // but cannot demux MP4, also skip rather than fail the suite.
  return null
}

/**
 * Writes the MP4 (base64) to a temp file and runs `ffmpeg -i` on it.
 * Returns ffmpeg's stderr probe output, or null when no MP4-capable
 * binary is available (callers skip rather than fail).
 */
export const probeMp4WithFfmpeg: BrowserCommand<[base64Mp4: string]> = (
  _ctx,
  base64Mp4,
): string | null => {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) return null

  const dir = mkdtempSync(join(tmpdir(), 'kody-mp4-meta-'))
  const file = join(dir, 'export.mp4')
  writeFileSync(file, Buffer.from(base64Mp4, 'base64'))

  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return ''
  } catch (err) {
    // ffmpeg -i exits non-zero without an output file; stderr still has the probe.
    return err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr: unknown }).stderr)
      : ''
  }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    probeMp4WithFfmpeg: (base64Mp4: string) => Promise<string | null>
  }
}
