import { beforeEach, describe, expect, it } from 'vitest'
import {
  BackupFormatError,
  dataTransferHasFiles,
  importKodyVideoBackupFile,
  importProjectBackup,
  isKodyVideoBackupFile,
  kodyVideoBackupFilesFromList,
  parseProjectBackup,
  projectBackupFilename,
  serializeProject,
} from './project-transfer'
import { __resetDbForTests, getClipsForProject, getProjectAudio, listProjects } from './storage'
import { markWatermarkRemoved } from './entitlement'
import type { ClipRecord, Project, ProjectAudioRecord } from './types'

function fakeProject(name = 'Road Trip'): Project {
  return { id: 'proj_x', name, createdAt: 1, updatedAt: 2, clipIds: ['clip_a', 'clip_b'] }
}

function fakeAudio(contents: string[] = ['SONGBYTES']): ProjectAudioRecord {
  return {
    projectId: 'proj_x',
    tracks: contents.map((content, index) => ({
      id: `track_${index}`,
      blob: new Blob([content], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
      name: `song-${index + 1}.mp3`,
      addedAt: 1700000000000 + index,
    })),
    fadeIn: true,
    fadeOut: false,
  }
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

  it('parses backups without music with audio: null (older backups)', async () => {
    const backup = serializeProject(fakeProject(), [fakeClip('clip_a', 'AAAA')])
    const parsed = await parseProjectBackup(backup)
    expect(parsed.audio).toBeNull()
  })

  it('round-trips the music playlist, fades, and per-clip volumes', async () => {
    await markWatermarkRemoved('cs_test_transfer')
    const clips = [
      fakeClip('clip_a', 'AAAA', { clipVolume: 0.3, musicVolume: 0.8, audioPeak: 0.45 }),
      fakeClip('clip_b', 'BBBB'),
    ]
    const backup = serializeProject(
      fakeProject('Scored'),
      clips,
      fakeAudio(['SONGBYTES', 'MORESONG']),
    )

    const parsed = await parseProjectBackup(backup)
    expect(parsed.audio?.fadeIn).toBe(true)
    expect(parsed.audio?.fadeOut).toBe(false)
    expect(parsed.audio?.tracks.map((track) => track.name)).toEqual([
      'song-1.mp3',
      'song-2.mp3',
    ])
    expect(await parsed.audio!.tracks[0].blob.text()).toBe('SONGBYTES')
    expect(await parsed.audio!.tracks[1].blob.text()).toBe('MORESONG')
    expect(parsed.clips[0].clipVolume).toBe(0.3)
    expect(parsed.clips[0].musicVolume).toBe(0.8)
    // The normalization measurement travels too — imported clips skip the
    // re-measure on their first load.
    expect(parsed.clips[0].audioPeak).toBe(0.45)
    expect(parsed.clips[1].clipVolume).toBeUndefined()
    expect(parsed.clips[1].musicVolume).toBeUndefined()
    expect(parsed.clips[1].audioPeak).toBeUndefined()
    // Clip bytes stay aligned with the trailing audio section present.
    expect(await parsed.clips[1].blob.text()).toBe('BBBB')

    const project = await importProjectBackup(parsed)
    const audio = await getProjectAudio(project.id)
    expect(audio?.fadeIn).toBe(true)
    expect(audio?.fadeOut).toBe(false)
    expect(audio?.tracks.map((track) => track.name)).toEqual(['song-1.mp3', 'song-2.mp3'])
    expect(await audio!.tracks[0].blob.text()).toBe('SONGBYTES')
    expect(await audio!.tracks[1].blob.text()).toBe('MORESONG')
    const imported = await getClipsForProject(project.id)
    expect(imported[0].clipVolume).toBe(0.3)
    expect(imported[0].musicVolume).toBe(0.8)
    expect(imported[0].audioPeak).toBe(0.45)
    expect(imported[1].clipVolume).toBeUndefined()
    expect(imported[1].musicVolume).toBeUndefined()
  })

  it('round-trips per-track playback settings (trim, level, fades)', async () => {
    await markWatermarkRemoved('cs_test_transfer')
    const audio = fakeAudio(['SONGBYTES', 'MORESONG'])
    audio.tracks[0] = {
      ...audio.tracks[0],
      trimStartMs: 2_000,
      trimEndMs: 11_000,
      volume: 0.6,
      fadeIn: false,
      fadeOut: true,
    }
    const backup = serializeProject(fakeProject('Scored'), [fakeClip('clip_a', 'AAAA')], audio)

    const parsed = await parseProjectBackup(backup)
    expect(parsed.audio?.tracks[0]).toMatchObject({
      trimStartMs: 2_000,
      trimEndMs: 11_000,
      volume: 0.6,
      fadeIn: false,
      fadeOut: true,
    })
    // The second track carries no per-track settings at all.
    expect(parsed.audio?.tracks[1].trimStartMs).toBeUndefined()
    expect(parsed.audio?.tracks[1].volume).toBeUndefined()
    expect(parsed.audio?.tracks[1].fadeIn).toBeUndefined()

    const project = await importProjectBackup(parsed)
    const imported = await getProjectAudio(project.id)
    expect(imported?.tracks[0]).toMatchObject({
      trimStartMs: 2_000,
      trimEndMs: 11_000,
      volume: 0.6,
      fadeIn: false,
      fadeOut: true,
    })
    expect(imported?.tracks[1].trimStartMs).toBeUndefined()
    expect(imported?.tracks[1].volume).toBeUndefined()
  })

  it('imports a music-carrying backup on a free device, skipping the playlist', async () => {
    const backup = serializeProject(fakeProject('Scored'), [fakeClip('clip_a', 'AAAA')], fakeAudio())
    const parsed = await parseProjectBackup(backup)
    const project = await importProjectBackup(parsed)

    expect((await getClipsForProject(project.id))).toHaveLength(1)
    expect(await getProjectAudio(project.id)).toBeUndefined()
  })

  it('rejects a backup whose audio section is truncated', async () => {
    const backup = serializeProject(fakeProject(), [fakeClip('clip_a', 'AAAA')], fakeAudio())
    await expect(parseProjectBackup(backup.slice(0, backup.size - 4))).rejects.toThrow(/damaged/i)
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

  it('recognizes dropped .kodyvideo files by extension', () => {
    expect(isKodyVideoBackupFile({ name: 'road-trip.kodyvideo' })).toBe(true)
    expect(isKodyVideoBackupFile({ name: 'Road-Trip.KODYVIDEO' })).toBe(true)
    expect(isKodyVideoBackupFile({ name: 'clip.mp4' })).toBe(false)
    expect(isKodyVideoBackupFile({ name: 'notes.kodyvideo.bak' })).toBe(false)
    expect(
      kodyVideoBackupFilesFromList([
        new File(['a'], 'trip.kodyvideo'),
        new File(['b'], 'clip.mp4', { type: 'video/mp4' }),
        new File(['c'], 'Second.KodyVideo'),
      ]).map((file) => file.name),
    ).toEqual(['trip.kodyvideo', 'Second.KodyVideo'])
    expect(kodyVideoBackupFilesFromList(null)).toEqual([])
    expect(dataTransferHasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true)
    expect(dataTransferHasFiles({ types: ['text/uri-list'] } as unknown as DataTransfer)).toBe(
      false,
    )
    expect(dataTransferHasFiles(null)).toBe(false)
  })

  it('imports a backup file through the shared picker/drop helper', async () => {
    const backup = serializeProject(fakeProject('Dropped'), [fakeClip('clip_a', 'MEDIA')])
    const file = new File([backup], 'dropped.kodyvideo', { type: 'application/octet-stream' })
    const project = await importKodyVideoBackupFile(file)
    const clips = await getClipsForProject(project.id)
    expect(project.name).toBe('Dropped')
    expect(clips).toHaveLength(1)
    expect(await clips[0]!.blob.text()).toBe('MEDIA')
  })
})
