# Recording smoothness: findings and field reports

Why hold-to-record can drop frames, what was fixed, what is still a
suspect, and how to pull a recording-health report off a phone after a
trip.

## TL;DR

- **Proven in Chromium:** a main-thread stall of roughly 200ms or more
  during a take drops frames from the *saved file*. The frames never reach
  MediaRecorder. Stalls of 60, 100, and 150ms were absorbed; 250ms stalls
  lost about 3 frames each. Chrome/Brave on Android is the same engine, so
  anything that blocks the main thread mid-take on a phone is a real drop
  source.
- **Fixed:** optional post-take work (clip hydration: container parses of
  every clip plus an audio-peak decode) now waits while a take is recording
  (`src/lib/capture-activity.ts`). Refreshes also no longer re-parse every
  clip already verified in this session.
- **Fixed:** drag-to-zoom sent one `applyConstraints` per pointermove with
  nothing bounding how many were in flight. A latest-wins writer
  (`src/lib/zoom-writer.ts`) keeps one write in flight, at most one per
  camera frame. Measured on one 4s drag: 224 camera writes before, 56 after.
- **Inconclusive on device:** in this VM, the app's own post-take pipeline
  never stalled long enough to drop frames, even at 6× CPU throttle with a
  25-clip project. The remaining suspects are device-side: camera frame
  rate in dim light, heat, the hardware encoder, and real zoom hardware.
  Every take now writes an on-device report that tells these apart (see
  [Remaining suspects](#remaining-suspects)).

## Capture pipeline (where frames can be lost)

```
camera (getUserMedia, 30fps ideal)
 ├─ preview <video>                         viewfinder (what you watch)
 └─ clone track ── MediaRecorder ── Blob    the saved file (what you keep)
                   (H.264/MP4 on phones, no timeslice, warm pre-armed session)
 release → 200ms stop grace → onstop → measure duration → copy blob →
 IndexedDB → refresh → hydrate (display size, thumbs, audio peak)
```

Loss points, in order:

1. **Camera** produces fewer than 30 frames per second (dim-light exposure,
   heat, device limits). Chromium on Android deliberately picks auto-exposure
   ranges with a low minimum fps so dim scenes stay exposed. No web
   constraint pins that minimum.
2. **Delivery**: the camera produced a frame, but it never reached
   MediaRecorder. Chromium's track counters (`track.stats`) show this
   directly. This is what a main-thread stall causes.
3. **Encoder/muxer**: MediaRecorder got the frame, but it isn't in the file.
4. **Kept range**: startup hole or freeze at the head (cold encoder start),
   or backgrounding mid-take.
5. **Export** (not capture): holds the last frame across source gaps and only
   drops frames closer than half a 30fps tick. The logic checks out for
   jittery 30fps and for 60fps sources.

## What was measured

`scripts/probe-capture-cadence.mjs` records real hold-to-record takes in
Chromium with a fake 30fps camera, reads each saved clip's frame timestamps
(metadata-only demux, no decoding), and lines them up with long tasks and
event-loop lag during the hold. It also prints the app's own take report,
so the production telemetry is checked against ground truth.

| Scenario (4s hold) | Frames missing | Worst gap | Main thread during hold |
| --- | --- | --- | --- |
| Idle record screen | 0 / 120 | 34ms | no long tasks |
| Right after another take, 25-clip project, 6× CPU throttle | 0 / 121 | 37ms | no long tasks |
| Drag-to-zoom sweep (zoom range shimmed on the fake camera) | 0 / 120 | 35ms | 224 → 56 `applyConstraints` |
| Injected 60ms stall every 250ms | 0 / 120 | 34ms | 16 long tasks |
| Injected 100ms stall every 300ms | 0 / 122 | 34ms | 14 long tasks |
| Injected 150ms stall every 400ms | 0 / 120 | 34ms | 10 long tasks |
| **Injected 250ms stall every 500ms** | **24 / 118** | **134–167ms** | 8 long tasks |

On the 250ms-stall take, Chromium's track counters were 131 frames produced,
104 delivered to MediaRecorder, and 100 in the file. On every healthy take
the three numbers matched exactly (e.g. 127/127/127). The app's report
graded it `choppy` with reasons `main-thread` and `delivery-loss`, and
located each gap inside a measured stall.

Hypotheses checked and discarded:

- "The 60ms audio gaps in every clip are dropouts." They weren't. WebM
  blocks without a duration read as gaps. The audio is continuous.
- "The export frame clock drops good frames." It doesn't: jittery 30fps
  passes through intact and 60fps is decimated correctly.
- "Main-thread re-renders during the take." Earlier work already removed
  these (#153, #122). The probe saw no long tasks on an idle take.

## Remaining suspects

Each suspect has a signal in the take report that confirms or rules it
out. Look at `reasons`, then the fields listed.

| Suspect | Report signal | Notes |
| --- | --- | --- |
| Dim light / heat lowers camera fps | `camera-rate`; `cadence.medianIntervalMs` about 67 (15fps) or 42 (24fps); `encoder.trackFrames.total` ÷ `encoder.sessionMs` | Uniformly slow, not bursty. Correlate with time of day and `env.battery`, `env.pressure`. |
| Main-thread stalls on the phone (GC, saving a big previous take) | `main-thread`, `delivery-loss`; `live.mainThread.stalls`; `env.previousSaveInFlight` | The proven Chromium mechanism. If this shows up, find what ran by stall time. |
| Drag-to-zoom on real camera hardware | `zoom`; `live.zoom.requested` / `applied` | The writer bounds writes to 30/s. If gaps still line up with zoom windows, the camera stack itself is hitching. |
| Cold encoder start (first take, or after the mic's 60s keep-warm lapses) | `cold-start`; `encoder.warmAgeMs` under 250; `cadence.headGapMs` | Shows as a frozen or missing head, not mid-take stutter. |
| Heat from the always-warm encoder | `env.idleEncoder.encodeMs`, `env.cameraOpenMs`, `env.pressure` | The record screen keeps a hardware encoder running (recycled every 1.5s) so presses skip the startup hole. If choppy takes cluster after long idle stretches on the camera, this trade-off is costing frames. |
| Hardware encoder overload | `encoder-loss` (`trackFrames.delivered` > frames in the file) | Delivered-but-missing frames point at MediaRecorder / MediaCodec. |
| App hidden mid-take | `backgrounded`; `live.hidden` | The take is flushed on hide by design. |
| Viewfinder only (the file is fine) | `live.preview.dropped` high while `verdict` is `smooth` | The preview can stutter while the recording stays clean. |

## Pulling a report after a trip (on the phone)

1. Open Kody Video (the installed app or kody.video) and tap the **ⓘ**
   button on the home screen to open About. Or go to
   `kody.video/about#recording-health`.
2. **Recording health** lists recent takes, one line each: time, length,
   fps, missing frames, worst gap, and the likely cause. A dot marks each
   take green (smooth), amber (small hiccup), or red (choppy). The summary
   line gives totals and the most common cause.
3. Get the full report off the phone:
   - **Send to Kody Video** (kody.video only) sends it to Sentry as one
     info event titled "Recording health report", tagged
     `step:recording-report`. The full JSON is attached as
     `kody-video-recording-report.json`, and the summary is in the
     `recording` context.
   - **Share report** opens the share sheet with a `.txt` file holding the
     JSON (Chrome's share allowlist has no `.json`). It falls back to a
     download.
   - **Copy** puts the JSON on the clipboard.
4. **Clear** (tap twice) starts fresh. Up to 300 takes are kept.

Reports hold timings and counters only: no video, audio, location, or
project names (see the privacy page). They live in their own IndexedDB
database, `kody-video-diagnostics`, so backups never carry them.

### Reading one take

```jsonc
{
  "verdict": "choppy",                // smooth | minor | choppy | unknown
  "reasons": ["main-thread", "delivery-loss"],
  "holdMs": 4000,
  "cadence": {                        // the KEPT range of the saved file
    "fps": 24.1, "frames": 94, "expectedFrames": 118,
    "droppedFrames": 24, "stalls": 8, "maxGapMs": 134,
    "medianIntervalMs": 33.3,         // ~33 = camera at 30fps
    "headGapMs": 0,
    "gapHistogram": { "0": 85, "1": 0, "2-3": 8, "4-8": 0, "9+": 0 }
  },
  "gaps": [{ "atMs": 1233, "gapMs": 134, "missing": 3, "reason": "main-thread" }],
  "encoder": {
    "warmAgeMs": 1, "sessionMs": 4375, "flushMs": 1, "measureMs": 12,
    "trackFrames": { "total": 131, "delivered": 104, "discarded": 0 }
  },
  "live": {
    "mainThread": { "maxLagMs": 220, "stalls": [{ "atMs": 1121, "durationMs": 251 }] },
    "zoom": { "requested": 0, "applied": 0, "windows": [] },
    "hidden": [], "backgroundWork": []
  },
  "env": { "os": "android", "browser": "chrome", "cameraOpenMs": 5000,
           "previousSaveInFlight": false, "idleEncoder": { "sessions": 3, "encodeMs": 2600 } }
}
```

`atMs` in `gaps` is measured from the start of the kept range. Live
windows (`stalls`, zoom `windows`, `hidden`) are measured from the press.
The two line up to within a couple hundred ms, and a gap is matched to a
live event within ±250ms. `trackFrames` comes from Chromium only; Safari
has no equivalent.

## Reproducing locally

```bash
npm run dev -- --host 127.0.0.1 --port 5173   # or let the probe start its own
node scripts/probe-capture-cadence.mjs --base=http://127.0.0.1:5173
node scripts/probe-capture-cadence.mjs --scenario=jank --jank=250:500
node scripts/probe-capture-cadence.mjs --scenario=back-to-back --throttle=6 --seed=25
```

Point `--base` at a checkout of another branch to compare before and
after. Builds without take reports print cadence only.
