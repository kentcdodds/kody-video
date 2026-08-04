# Manual camera testing (headless / cloud VM)

The Cursor Cloud VM has no real camera or microphone. To exercise the
camera → record → export flow in a real browser, launch Chrome with fake-media
flags:

```bash
DISPLAY=:1 google-chrome \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream \
  --user-data-dir=/tmp/chrome-profile \
  http://localhost:5173/
```

Without these flags the app correctly shows a "No camera was found" error.

Expected quirks in this environment (not bugs):

- The preview is a synthetic green test pattern.
- A red "Mic isn't picking up sound" warning appears during recording (the fake
  mic produces no real audio).
- On Linux/Chromium the export falls back to WebM (no MP4 hardware encoder).
  MP4 (H.264/AAC) is preferred only where the platform exposes those encoders.
