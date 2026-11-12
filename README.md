# dbx-desktop

A desktop companion for Databricks. `dbx-desktop` is a working codename. The agreed design is in [SPEC.md](SPEC.md).

Built with [Wails v3](https://v3.wails.io/): a Go backend using the official Databricks Go SDK, and a React and TypeScript frontend rendered in the OS webview.

## Status

Pillar 1, the workspace hub, is built:

- Profile manager over `~/.databrickscfg`: add, remove, set the CLI default
- Browser OAuth sign-in through the Databricks CLI, or a personal access token
- Workspace switcher with per-workspace color, nickname and production flag
- Overview for the active workspace: failed runs in the past 24 hours and SQL warehouse states

Pillars 2 to 5 (SQL scratchpad, file drop, jobs monitor, local projects) are not started.

## Requirements

- Go 1.26 or later
- Node.js and npm
- The Wails CLI: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`
- The Databricks CLI, for browser sign-in

## Commands

```bash
wails3 dev          # run with live reload
wails3 build        # production build into bin/
go test . ./internal/...
```

To try the UI in a browser without a native window, build server mode and run it against a throwaway config:

```bash
wails3 task build:server DEV=true
DATABRICKS_CONFIG_FILE=/tmp/test.databrickscfg DBX_DESKTOP_CONFIG_DIR=/tmp/dbx-desktop WAILS_SERVER_PORT=18099 ./bin/dbx-desktop-server
```

## Layout

| Path | What it holds |
|---|---|
| `main.go` | App entry point and window setup |
| `workspaceservice.go` | The service the frontend calls: profiles, sign-in, overview |
| `internal/dbcfg` | Reads and writes `~/.databrickscfg`, with a `.bak` backup on every write |
| `internal/dbcli` | Finds the Databricks CLI and runs its browser login |
| `internal/settings` | App-only metadata (color, nickname, production flag, default volume) |
| `frontend/src` | React UI |
| `frontend/bindings` | Generated TypeScript bindings; do not edit |

## Where data lives

- Profiles: `~/.databrickscfg` (or `DATABRICKS_CONFIG_FILE`)
- App settings: `settings.json` in the per-user config folder under `dbx-desktop` (or `DBX_DESKTOP_CONFIG_DIR`)
- OAuth tokens: the Databricks CLI's own token cache. The app stores no credentials.
