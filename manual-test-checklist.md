# Manual camera checklist (Chrome / Android) — Kody Video

Run locally with HTTPS or `localhost` (`npm run dev`). Camera/mic require a secure context.

## Permissions
- [ ] First open prompts for camera; microphone is requested when you start recording
- [ ] Idle preview does not block Android voice-to-text in Brave/Chrome
- [ ] Deny → clear denied panel with retry guidance
- [ ] Allow → live rear-camera preview (or fallback)
- [ ] Flip camera works when multiple cameras exist
- [ ] Torch toggle appears on devices with a flash; zoom chips appear when supported
- [ ] Backgrounding the app releases camera/mic (green dot goes out); returning restarts the preview
- [ ] Backgrounding mid-recording still saves the take
- [ ] Screen off → on while on the camera view: preview is live again, not frozen; recording works
- [ ] Light/dark follows system `prefers-color-scheme`

## Hold-to-record
- [ ] Press/hold anywhere on the preview starts recording (REC pill + elapsed)
- [ ] Camera preview stays smooth while recording (no visible frame drops)
- [ ] Dragging up/down during a hold zooms in/out (zoom-capable devices)
- [ ] Releasing the hold eases zoom back to the pre-take level (chip choice or 1×)
- [ ] Release stops and appends a clip; filmstrip thumbnail appears shortly after
- [ ] Self-timer counts down, starts hands-free recording, then tap stops
- [ ] Very short taps do not create empty clips ("Hold a bit longer")
- [ ] Multiple holds create multiple clips; total duration in the top bar updates
- [ ] Backspace button deletes the last clip; toast offers Undo

## Editor
- [ ] Scissors button opens the editor; stage shows the selected clip
- [ ] Timeline tiles are wider for longer clips and show real thumbnails
- [ ] Tap selects; long-press (or horizontal drag) lifts a tile to reorder
- [ ] Trim opens the expanded strip; dragging handles seeks the stage preview
- [ ] Done persists the trim; tile width and total duration update
- [ ] Duplicate inserts a copy after the selection; Delete offers Undo
- [ ] Tapping the stage plays just the selected clip within its trim range

## Preview playback
- [ ] Play button previews the whole cut in order, honoring trims, with audio
- [ ] Tap right/left edge skips to next/previous clip; tap middle stops
- [ ] Segmented progress bar tracks clips

## OK / export
- [ ] OK starts the export immediately ("Exporting your video…" + progress)
- [ ] Export completes; sheet shows format + size ("MP4 · x MB" expected on Android)
- [ ] Share opens the system share sheet (fresh tap, no silent failure)
- [ ] Save stores the file locally
- [ ] Exported video: clips in order, trims applied, audio in sync across clips, smooth frame rate
- [ ] Export failure path offers "Save clips instead"
- [ ] Network tab shows no upload of clip binaries

## Persistence / offline
- [ ] Hard refresh restores projects and clip media
- [ ] Airplane mode after first visit still loads the app shell (PWA/service worker)
- [ ] Offline, existing projects open and clips play from IndexedDB

## Projects
- [ ] Create up to 6 projects; 7th is blocked with clear UX
- [ ] Slot order is stable (does not shuffle after opening projects)
- [ ] Slots show poster art from the first clip
- [ ] ⋯ menu: Open / Rename / Delete (styled confirm, no browser dialog)
- [ ] Deleting a project frees its stored clips
