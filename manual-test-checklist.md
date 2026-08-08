# Manual test checklist — Kody Video

Most of the old checklist is now asserted automatically — run it before every
release:

```sh
npm run test:e2e   # Playwright suite (tests/e2e/, ~40s, fake camera/mic)
npm test           # unit tests
```

## What the automated suite covers (don't re-test by hand)

`npm run test:e2e` asserts, in a real Chromium with fake camera/mic:

- **Permissions & camera**: allow → live preview; deny → permission panel with
  "Try again"; light/dark follows `prefers-color-scheme`
- **Hold-to-record**: press/hold shows the REC pill with elapsed time; release
  appends a clip; short taps show "Hold a bit longer" and save nothing;
  multiple holds append; Backspace-delete offers Undo and Undo restores;
  self-timer counts down and records hands-free until tapped
- **Lazy creation & plans**: "New project" creates nothing until the first
  clip (URL flips from `/project/new`); backing out leaves no project;
  recording a clip, deleting it, and backing out auto-deletes the
  default-state project (no notification); free plan locks slots 2–6 behind
  the Plus upsell; Plus unlocks 6 and blocks the 7th; the upsell sheet copy
  and buttons
- **Orientation (Plus)**: the camera-view toggle is locked (opens the upsell)
  on the free plan; with Plus it flips the project to landscape — the shell
  widens, a "turn your device" hint shows while upright, the record controls
  become a right-hand rail sideways, and exports come out landscape (portrait
  clips center-crop); the setting survives reload; toggling back to portrait
  restores everything (backup/import round-trip of the setting is covered by
  the unit suite)
- **Location**: toggle asks permission, `aria-pressed` reflects state, new
  clips carry exact coordinates, toasts confirm on/off
- **Editor**: opens at the most recent clip; tap selects; tiles show
  filmstrip thumbnails; duplicate inserts the copy right after the selection;
  delete offers Undo; trim strip opens, dragging the end handle + Done
  persists `trimEndMs` and updates the tile duration; **Add** imports a
  video from the device onto the timeline
- **Playback**: whole cut with segmented progress; edge taps skip
  next/previous; middle tap stops; auto-closes at the end of the cut
- **Go / export**: full export to a ready sheet with format + size; Save
  downloads the file; "Save original clips (.zip)" downloads an archive;
  closing and tapping Go again restores the cached export instantly; editing
  clips invalidates the restore; "Re-export from scratch" renders fresh; the
  watermark upsell shows before purchase; **no non-GET request leaves the
  device** during record/export/save/zip
- **Projects**: slots show poster art; rename via the options sheet; delete
  uses the styled confirm (no browser dialog) and frees stored clips; backup
  downloads a `.kodyvideo` file and import (About → Import a backup, or drop
  the file anywhere in the app) restores it; import at the plan limit is
  refused with a clear message; slot order is stable
- **Storage**: the footer storage gauge opens a "X of Y used" popover on
  tap; ≥80% shows the amber banner, ≥92%
  turns critical; the banner offers one-tap "Clear cached exports"; the boot
  sweep removes orphaned cache files but keeps the referenced last export;
  deleting a project drops its cached export; the About page shows the cache
  size with a working Clear button; exactly one recoverable export lives on
  disk after an export (no temp/zip/duplicate leaks)
- **Desktop keyboard**: key hints on fine-pointer devices; hold Space
  records and a sub-120ms tap never sticks; E editor / Esc back / P play /
  Delete removes last; editor arrows select, Alt+arrows reorder, D
  duplicates, Delete deletes, T trims; playback Space pauses/resumes and
  arrows skip; typing in the rename field never triggers shortcuts
- **iOS install hint**: shows in iOS Safari with the exact copy, dismisses
  permanently, hidden in standalone and non-iOS browsers
- **Meta**: `viewport-fit=cover`, `apple-mobile-web-app-status-bar-style`
  black-translucent, theme colors, og/twitter card tags; onboarding shows
  once and dismisses for good; /about, /privacy, /terms render

Specialized probes (run each individually, e.g.
`node scripts/probe-fast-export.mjs`) additionally cover: the fast
export pipeline end-to-end with ffprobe validation (30fps decimation, export
recovery, zip contents), touch timeline gestures (long-press lift, drag
reorder, scroll), the silent-mic warning pill, screen recording, rear-lens
switching, and WebKit engine sanity.

## Still manual — real device required (Chrome/Brave on Android, Safari on iOS)

Camera/mic need a secure context: `localhost` only counts when the browser
and dev server are on the same machine. For a phone, use your machine's LAN
URL over HTTPS or a trusted tunnel (`npm run dev -- --host` plus a tunnel;
see the README) — plain `http://<lan-ip>` fails in most browsers.

### Camera hardware & OS integration
- [ ] Real permission prompts: camera on first open, mic priming; Brave does
  not silence the mic prompt; a blocked mic shows the red "Mic blocked" pill
- [ ] Idle preview does not block Android voice-to-text in Brave/Chrome; the
  mic is NOT held while idle (no OS mic indicator) — except iOS, where it is
  held while previewing (muted-track workaround)
- [ ] iOS: recordings have audible sound (mic + camera in one combined request)
- [ ] iOS with an external mic (DJI transmitter, AirPods, wired headset):
  recordings capture from the external mic, not the built-in one (the
  audio-session kick after camera open re-routes); playback audio quality is
  normal after leaving the camera
- [ ] A take with a dead/covered mic shows "Mic isn't picking up sound" after
  ~2.5s; a take with sound clears it
- [ ] Torch toggle appears on devices with a flash; zoom chips when supported
- [ ] Long digital ranges: the top zoom chip caps at 10× but drag-zoom still
  reaches the camera's true max (e.g. 30×), with the HUD showing real values
- [ ] Multi-rear-lens Androids show the lens chip (e.g. "1/3"); choice sticks
  across flips and restarts. iOS: NO lens chip; multi-lens iPhones open the
  virtual device so zoom spans 0.5×–max
- [ ] Android phones exposing a logical multi-camera (a rear lens whose zoom
  chips include 0.5×/0.6×): after opening that lens once, the app reopens it
  on every session and drag-zoom hands off between physical lenses
  seamlessly, including mid-recording; a manual chip switch afterward
  overrides the memory until the seamless lens is opened again
- [ ] Dragging up/down during a hold zooms; edge presses keep a minimum ramp;
  small tremble (<~14px) doesn't zoom; release eases back to the pre-take level
- [ ] A zoom readout (e.g. "2.3×") appears near the top of the preview while
  the zoom changes (drag, chip tap, or ease-back) and fades out ~1s after
- [ ] Camera preview stays smooth while recording (no visible frame drops)
- [ ] Ending a take does not flash the preview black (Android regression)
- [ ] Backgrounding releases camera/mic (green dot goes out); returning
  restarts the preview; backgrounding mid-recording still saves the take
- [ ] Screen off → on while on the camera: preview live again, not frozen
- [ ] Flip camera works when multiple cameras exist

### Screen recording (desktop)
- [ ] Picking a surface starts the take; browser "Stop sharing", the monitor
  button, `S`, and tapping the preview all save the clip
- [ ] Mic narration is mixed with tab/system audio; denied mic still records
  video; cancelling the picker shows no error

### Export output quality (watch the file)
- [ ] Exported video: clips in order, trims applied, audio in sync across
  clips with no clicks at joints, smooth frame rate
- [ ] Watermark (before purchase): small Kody mark + domain bottom-right at
  50% opacity; gone after purchase
- [ ] MP4 chapters at clip boundaries in VLC/mpv; with tagged clips,
  VLC/exiftool show the ©xyz geotag; old projects without location still
  export (chapters only)
- [ ] Share opens the system share sheet (fresh tap, no silent failure)
- [ ] Export failure path offers "Save clips instead"

### Purchases (Stripe, production)
- [ ] "Remove it — $0.99" opens Stripe checkout; KODYFRIEND checks out at $0
- [ ] After checkout, /unlocked verifies and celebrates; next export unmarked
- [ ] "Already paid?" restore accepts the receipt link and unlocks

### PWA / persistence
- [ ] Hard refresh restores projects and clip media
- [ ] Airplane mode after first visit still loads the app shell; offline,
  projects open and clips play
- [ ] iOS installed app fills the whole screen: background paints behind the
  status bar clock, no content under the Dynamic Island
- [ ] Opening /og-image.png directly (service worker active) shows the image,
  not the app
- [ ] On kody-video.pages.dev, home shows the "moved to kody.video" migration
  banner (absent on kody.video)
- [ ] On remix.kody.video, home shows the dismissible showcase note linking
  kody.video and PR #87; dismissing hides it across reloads (absent on
  kody.video)
- [ ] Import a backup on another domain/device: clips, trims, and geo survive
- [ ] ≥92% storage: the record screen pill turns red and starting a recording
  shows the warning toast
