# Cloud development setup

Use the existing `/workspace/DOM` checkout. Tasks already run in isolated environments; do not create a Git worktree unless explicitly requested.

Node 24, npm, Chromium system libraries and native SQLite support are available. Required dependency/bootstrap steps:

```sh
cd /workspace/DOM
export XDG_CACHE_HOME=/workspace/.cache
export npm_config_cache=/workspace/.cache/npm
export electron_config_cache=/workspace/.cache/electron
export ELECTRON_CACHE=/workspace/.cache/electron
export ELECTRON_BUILDER_CACHE=/workspace/.cache/electron-builder
export NODE_USE_ENV_PROXY=1
npm ci
node node_modules/electron/install.js
npm run prepare:browser
npm run typecheck
npm run build
```

The retained `/workspace/.cache/xvfb/install-xvfb.sh` downloads and extracts signed Debian packages without changing the host package database. `/workspace/.cache/xvfb/start-xvfb.sh :99` starts a 1440×1000 virtual display. Both were exercised during onboarding. The reusable environment install draft includes the installation helper contents so refresh does not depend solely on a cached binary.

Before graphical QA, start Xvfb if needed and set:

```sh
export DISPLAY=:99
export DOM_DATA_DIR=/workspace/DOM/.local/user-data
mkdir -p "$DOM_DATA_DIR"
export DOM_DISABLE_CHROMIUM_SANDBOX=1
export XDG_CACHE_HOME=/workspace/.cache
npm run test:desktop
```

The sandbox override is specific to this isolated cloud container's unusable OS sandbox helper. Production desktop launches retain the browser sandbox. A virtual-display process is not retained by filesystem snapshots and must restart. For interactive development use the same initialized shell and `npm run dev`; validate using the local application and fixtures. The onboarding UI does not expose localhost web previews.

Required download hosts include the existing package-manager/GitHub preset plus `cdn.playwright.dev`, `storage.googleapis.com` and `playwright.download.prss.microsoft.com`. GitHub release operations use `api.github.com` and `uploads.github.com`. The optional live workflow also needs the configured proxy API host and permitted search/navigation destinations. Do not print or copy environment/proxy/Git credentials; use injected HTTPS Git authentication.
