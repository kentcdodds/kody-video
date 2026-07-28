# Manual camera checklist (Chrome / Android) — Kody Video

Run locally with HTTPS or `localhost` (`npm run dev`). Camera/mic require a secure context.

## Permissions
- [ ] First open prompts for camera; microphone is requested when you start recording
- [ ] Idle preview does not block Android voice-to-text in Brave/Chrome
- [ ] Deny → clear denied panel with retry guidance
- [ ] Allow → live rear-camera preview (or fallback)
- [ ] Flip camera works when multiple cameras exist
- [ ] Torch toggle appears on devices with a flash; zoom chips appear when supported
- [ ] Phones with multiple rear cameras show a lens chip (e.g. "1/3") that switches to the ultra-wide/telephoto; choice sticks across flips and restarts
- [ ] Backgrounding the app releases camera/mic (green dot goes out); returning restarts the preview
- [ ] Backgrounding mid-recording still saves the take
- [ ] Screen off → on while on the camera view: preview is live again, not frozen; recording works
- [ ] Light/dark follows system `prefers-color-scheme`

## Hold-to-record
- [ ] Press/hold anywhere on the preview starts recording (REC pill + elapsed)
- [ ] Camera preview stays smooth while recording (no visible frame drops)
- [ ] Dragging up/down during a hold zooms in/out (zoom-capable devices)
- [ ] Dragging from the press point to the top of the preview reaches MAX zoom; to the bottom reaches MIN (presses within ~20% of an edge keep a minimum ramp instead and cap partway at that edge — no hair-trigger)
- [ ] Small finger tremble while holding (< ~14px) does not start zooming
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

## Chapters & location
- [ ] Location toggle asks permission on first enable; pressed state shows while on
- [ ] Clips recorded while on carry coordinates; toggle off stops tagging
- [ ] MP4 export shows chapters at clip boundaries in VLC/mpv (titles = clip times)
- [ ] With tagged clips, VLC/exiftool show the ©xyz geotag; Photos apps place the video
- [ ] Old projects without location data export fine (chapters only, no geotag)

## Preview playback
- [ ] Play button previews the whole cut in order, honoring trims, with audio
- [ ] Tap right/left edge skips to next/previous clip; tap middle stops
- [ ] Segmented progress bar tracks clips

## Go / export
- [ ] Go starts the export immediately ("Exporting your video…" + progress)
- [ ] Export completes; sheet shows format + size ("MP4 · x MB" expected on Android)
- [ ] Share opens the system share sheet (fresh tap, no silent failure)
- [ ] Save stores the file locally
- [ ] Exported video: clips in order, trims applied, audio in sync across clips, smooth frame rate
- [ ] Export failure path offers "Save clips instead"
- [ ] Network tab shows no upload of clip binaries
- [ ] Exported video shows the small Kody mark bottom-right (before purchase)
- [ ] "Remove it — $0.99" opens Stripe checkout; KODYFRIEND promo checks out at $0
- [ ] After checkout, /unlocked verifies and celebrates; next export has no mark
- [ ] "Already paid?" restore accepts the receipt link and unlocks

## Persistence / offline
- [ ] Hard refresh restores projects and clip media
- [ ] Airplane mode after first visit still loads the app shell (PWA/service worker)
- [ ] Offline, existing projects open and clips play from IndexedDB

## Storage
- [ ] Home shows "X of Y used" in the footer line
- [ ] ≥80% full: amber banner on home with delete-a-project guidance; pill on the record screen
- [ ] ≥92% full: banner/pill turn red; starting a recording shows a warning toast
- [ ] Watermark (before purchase) shows the mark + domain at 50% opacity

## Projects
- [ ] Create up to 6 projects; 7th is blocked with clear UX
- [ ] Slot order is stable (does not shuffle after opening projects)
- [ ] Slots show poster art from the first clip
- [ ] ⋯ menu: Open / Rename / Delete (styled confirm, no browser dialog)
- [ ] Deleting a project frees its stored clips
- [ ] ⋯ → Save backup produces a .kodyvideo file (share sheet on Android)
- [ ] Import on another domain/device restores the project with clips, trims, and geo
- [ ] Importing at the 6-project cap is blocked with a clear message
- [ ] On kody-video.pages.dev, home shows the "moved to kody.video" migration banner (absent on kody.video)

## Desktop keyboard (fine-pointer devices)
- [ ] Key-hint lines appear on the record screen and editor (hidden on touch devices)
- [ ] Hold Space records; release stops; a sub-120ms tap does not leave a stuck recording
- [ ] F flips camera, T starts self-timer, E opens editor, P plays, Delete removes last clip
- [ ] Editor: arrows select, Alt+arrows reorder, T trims, D duplicates, Delete deletes, Esc returns to camera
- [ ] Playback overlay: arrows skip, Space pauses/resumes, Esc closes; editor keys stay inert underneath
- [ ] Typing in a rename field never triggers shortcuts

## Social / meta
- [ ] Opening /og-image.png directly (with the app's service worker active) shows the image, not the app
