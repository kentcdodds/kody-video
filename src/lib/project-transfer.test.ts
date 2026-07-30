import { beforeEach, describe, expect, it } from 'vitest'
import {
  BackupFormatError,
  importProjectBackup,
  parseProjectBackup,
  projectBackupFilename,
  serializeProject,
} from './project-transfer'
import { __resetDbForTests, getClipsForProject, listProjects } from './storage'
import type { ClipRecord, Project } from './types'

function fakeProject(name = 'Road Trip'): Project {
  return { id: 'proj_x', name, createdAt: 1, updatedAt: 2, clipIds: ['clip_a', 'clip_b'] }
}

function fakeClip(id: string, content: string, extra: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id,
    projectId: 'proj_x',
    blob: new Blob([content], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    durationMs: 1500,
    trimStartMs: 100,
    trimEndMs: 1200,
    createdAt: 1700000000000,
    lat: 40.2338,
    lng: -111.6585,
    locationAccuracyM: 12,
    ...extra,
  }
}

describe('project backup round trip', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('serializes and parses a project faithfully', async () => {
    const clips = [fakeClip('clip_a', 'AAAA'), fakeClip('clip_b', 'BBBBBBBB', { lat: undefined, lng: undefined })]
    const backup = serializeProject(fakeProject(), clips)

    const parsed = await parseProjectBackup(backup)
    expect(parsed.projectName).toBe('Road Trip')
    expect(parsed.clips).toHaveLength(2)
    expect(parsed.clips[0].trimStartMs).toBe(100)
    expect(parsed.clips[0].trimEndMs).toBe(1200)
    expect(parsed.clips[0].lat).toBe(40.2338)
    expect(parsed.clips[1].lat).toBeUndefined()
    expect(await parsed.clips[0].blob.text()).toBe('AAAA')
    expect(await parsed.clips[1].blob.text()).toBe('BBBBBBBB')
    expect(parsed.clips[0].blob.type).toBe('video/mp4')
  })

  it('imports a backup as a fresh project with trims and geo intact', async () => {
    const backup = serializeProject(fakeProject('Moved'), [fakeClip('clip_a', 'MEDIA')])
    const parsed = await parseProjectBackup(backup)
    const project = await importProjectBackup(parsed)

    const projects = await listProjects()
    expect(projects.map((p) => p.id)).toContain(project.id)
    const clips = await getClipsForProject(project.id)
    expect(clips).toHaveLength(1)
    expect(clips[0].trimStartMs).toBe(100)
    expect(clips[0].trimEndMs).toBe(1200)
    expect(clips[0].lat).toBe(40.2338)
    expect(clips[0].createdAt).toBe(1700000000000)
    expect(await clips[0].blob.text()).toBe('MEDIA')
  })

  it('reports per-clip progress during import', async () => {
    const backup = serializeProject(fakeProject('Progress'), [
      fakeClip('clip_a', 'AAAA'),
      fakeClip('clip_b', 'BBBB'),
    ])
    const parsed = await parseProjectBackup(backup)
    const seen: Array<[number, number]> = []
    await importProjectBackup(parsed, (done, total) => seen.push([done, total]))
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })

  it('rolls back the project when an import fails midway', async () => {
    const backup = serializeProject(fakeProject('Broken'), [fakeClip('clip_a', 'MEDIA')])
    const parsed = await parseProjectBackup(backup)
    // Corrupt one clip so addClip's trim restore blows up deterministically.
    parsed.clips[0].trimStartMs = Number.NaN

    await expect(importProjectBackup(parsed)).rejects.toThrow()
    const projects = await listProjects()
    expect(projects.map((p) => p.name)).not.toContain('Broken')
  })

  it('rejects non-backup files', async () => {
    await expect(parseProjectBackup(new Blob(['just a video']))).rejects.toThrow(/not a kody video/i)
  })

  it('marks validation failures as BackupFormatError (kept out of crash reporting)', async () => {
    await expect(parseProjectBackup(new Blob(['just a video']))).rejects.toBeInstanceOf(
      BackupFormatError,
    )
    const backup = serializeProject(fakeProject(), [fakeClip('clip_a', 'AAAAAAAAAA')])
    await expect(parseProjectBackup(backup.slice(0, backup.size - 4))).rejects.toBeInstanceOf(
      BackupFormatError,
    )
  })

  it('rejects truncated backups', async () => {
    const backup = serializeProject(fakeProject(), [fakeClip('clip_a', 'AAAAAAAAAA')])
    const truncated = backup.slice(0, backup.size - 4)
    await expect(parseProjectBackup(truncated)).rejects.toThrow(/damaged/i)
  })

  it('rejects a manifest with a non-integer clip byteLength', async () => {
    // A fractional byteLength would pass a Number.isFinite check but make the
    // clip byte offsets drift, misaligning (and silently corrupting) every
    // subsequent clip instead of failing cleanly.
    const manifest = {
      version: 1,
      app: 'kody-video',
      exportedAt: 1,
      projectName: 'Fractional',
      clips: [
        {
          mimeType: 'video/mp4',
          durationMs: 1500,
          trimStartMs: 0,
          trimEndMs: 1500,
          createdAt: 1,
          byteLength: 4.5,
        },
      ],
    }
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    const magic = new TextEncoder().encode('KODYVID1')
    const header = new Uint8Array(magic.byteLength + 4)
    header.set(magic, 0)
    new DataView(header.buffer).setUint32(magic.byteLength, manifestBytes.byteLength)
    // Provide plenty of media bytes so the offset + byteLength <= size guard
    // passes and the integer check is what does the rejecting.
    const media = new TextEncoder().encode('AAAAAAAA')
    const backup = new Blob([header, manifestBytes, media])

    await expect(parseProjectBackup(backup)).rejects.toThrow(/damaged/i)
  })

  it('builds a sensible filename', () => {
    expect(projectBackupFilename('Röad Trip!!')).toBe('r-ad-trip.kodyvideo')
    expect(projectBackupFilename('   ')).toBe('project.kodyvideo')
  })
})
