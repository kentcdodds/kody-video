# Manual camera checklist (Chrome / Android) — Go Video Go

Run locally with HTTPS or `localhost` (`npm run dev`). Camera/mic require a secure context.

## Permissions
- [ ] First open prompts for camera + microphone
- [ ] Deny → clear denied panel with retry guidance
- [ ] Allow → live rear-camera preview (or fallback)
- [ ] Flip camera works when multiple cameras exist

## Hold-to-record
- [ ] Press/hold anywhere on the preview starts recording (red pulse + elapsed)
- [ ] Release stops and appends a clip to the timeline
- [ ] Very short taps do not create empty clips
- [ ] Multiple holds create multiple clips; total duration updates

## Timeline editing
- [ ] Select a clip (border highlight)
- [ ] Delete removes clip from timeline
- [ ] Undo restores the last deleted clip
- [ ] Move left/right reorders
- [ ] Duplicate inserts a copy after the selection
- [ ] Trim in/out updates effective duration and preview

## Persistence / offline
- [ ] Hard refresh restores projects and clip media
- [ ] Airplane mode after first visit still loads the app shell (PWA/service worker)
- [ ] Offline, existing projects open and clips play from IndexedDB

## Export / share
- [ ] Share → Export produces a local WebM (or falls back with an error message)
- [ ] Network tab shows no upload of clip binaries
- [ ] “Files” downloads individual clips
- [ ] Web Share sheet appears on supporting mobile browsers; otherwise download

## Projects
- [ ] Create up to 6 projects; 7th is blocked with clear UX
- [ ] Rename / delete from home
- [ ] Deleting a project frees its stored clips
