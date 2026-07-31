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
  clip (URL flips from `/project/new`); backing out leaves no project; free
  plan locks slots 2–6 behind the Plus upsell; Plus unlocks 6 and blocks the
  7th; the upsell sheet copy and buttons
- **Location**: toggle asks permission, `aria-pressed` reflects state, new
  clips carry exact coordinates, toasts confirm on/off
- **Editor**: opens at the most recent clip; tap selects; tiles show
  filmstrip thumbnails; duplicate inserts the copy right after the selection;
  delete offers Undo; trim strip opens, dragging the end handle + Done
  persists `trimEndMs` and updates the tile duration
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
  downloads a `.kodyvideo` file and import restores it; import at the plan
  limit is refused with a clear message; slot order is stable
- **Storage**: footer shows "X of Y used"; ≥80% shows the amber banner, ≥92%
  turns critical
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

Specialized probes (`node scripts/probe-*.mjs`) additionally cover: the fast
export pipeline end-to-end with ffprobe validation (30fps decimation, export
recovery, zip contents), touch timeline gestures (long-press lift, drag
reorder, scroll), the silent-mic warning pill, screen recording, rear-lens
switching, and WebKit engine sanity.

## Still manual — real device required (Chrome/Brave on Android, Safari on iOS)

Run locally with HTTPS or `localhost` (`npm run dev`); camera/mic need a
secure context.

### Camera hardware & OS integration
- [ ] Real permission prompts: camera on first open, mic priming; Brave does
  not silence the mic prompt; a blocked mic shows the red "Mic blocked" pill
- [ ] Idle preview does not block Android voice-to-text in Brave/Chrome; the
  mic is NOT held while idle (no OS mic indicator) — except iOS, where it is
  held while previewing (muted-track workaround)
- [ ] iOS: recordings have audible sound (mic + camera in one combined request)
- [ ] A take with a dead/covered mic shows "Mic isn't picking up sound" after
  ~2.5s; a take with sound clears it
- [ ] Torch toggle appears on devices with a flash; zoom chips when supported
- [ ] Multi-rear-lens Androids show the lens chip (e.g. "1/3"); choice sticks
  across flips and restarts. iOS: NO lens chip; multi-lens iPhones open the
  virtual device so zoom spans 0.5×–max
- [ ] Dragging up/down during a hold zooms; edge presses keep a minimum ramp;
  small tremble (<~14px) doesn't zoom; release eases back to the pre-take level
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
- [ ] Import a backup on another domain/device: clips, trims, and geo survive
- [ ] ≥92% storage: the record screen pill turns red and starting a recording
  shows the warning toast
