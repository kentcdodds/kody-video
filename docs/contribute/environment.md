# Environment & dependencies

## Node version

This project requires Node `>=24.3.0` (the pinned `remix@3.0.0-beta.5` engine).

In the Cursor Cloud VM, Node 24 is installed via `nvm` and made the default.
The VM also ships a system Node 22 at `/exec-daemon/node` that would otherwise
win on `PATH`, so `~/.bashrc` prepends the nvm Node 24 `bin` to `PATH`. New
shells get Node 24 automatically; if you spawn a non-login shell and see Node
22, run:

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

## Install caveats

Install dependencies with `npm install` (npm is the package manager — there is
a `package-lock.json`).

npm 11 (bundled with Node 24) prints `allow-scripts` warnings for blocked
postinstall scripts (`esbuild`, `@sentry/cli`). This is safe to ignore:

- `esbuild` works via its `@esbuild/linux-x64` optional dependency.
- `@sentry/cli` is only needed for source-map upload at build time, which is
  skipped unless `SENTRY_AUTH_TOKEN` is set.

`npm run build`, `npm run dev`, and the test suites all work without approving
those scripts.
