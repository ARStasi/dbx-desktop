# dbx-desktop

A desktop companion for Databricks. `dbx-desktop` is a working codename. The agreed design is in [SPEC.md](SPEC.md).

Built with [Wails v3](https://v3.wails.io/): a Go backend using the official Databricks Go SDK, and a React and TypeScript frontend rendered in the OS webview.

## Status

Pillar 1, the workspace hub, is built:

- Profile manager over `~/.databrickscfg`: add, remove, set the CLI default
- Browser OAuth sign-in through the Databricks CLI, or a personal access token
- Workspace switcher with per-workspace color, nickname and production flag
- Overview for the active workspace: failed runs in the past 24 hours and SQL warehouse states

Pillar 2, the SQL scratchpad, is built:

- Query tabs backed by plain `.sql` files, saved automatically, in `Documents/dbx-desktop/<profile>/` by default
- Open any `.sql` file from disk, or drop one on the window
- The Scratch panel lists those local drafts and the Workspace panel lists files in Databricks; each opens with a banner saying where its files live, and workspace tabs carry a cloud icon
- Delete scratch files one at a time or several at once (Cmd/Ctrl-click, Shift-click, Cmd/Ctrl+A, then Delete). They go to the Trash on macOS and Linux, and their tabs close
- Save a query you want to keep to the Databricks workspace as a `.sql` file (Cmd/Ctrl+S). The scratch copy is removed, and the tab now edits the workspace file. Edits autosave to a local copy, and Cmd/Ctrl+S uploads them, after checking that nobody changed the file in Databricks in the meantime
- Workspace browser with recently used workspace files, to open hosted `.sql` files
- Cmd/Ctrl+Enter runs the selection, or the statement under the cursor
- Shift+Alt+F (or the Format button) formats the selection, or the whole query, for Databricks SQL; long lines wrap
- Results grid capped at 10,000 rows, with CSV export
- Unity Catalog browser, one catalog at a time, with a filter, insert buttons, and a per-workspace choice of which catalogs to show
- Warehouse picker with start and stop
- Per-workspace history of the last 200 statements
- Confirmation before destructive statements, and before any data-changing statement on a production workspace

Pillars 3 to 5 (file drop, jobs monitor, local projects) are not started.

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
(cd frontend && npm test)
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
| `internal/settings` | App-only metadata (color, nickname, production flag, default volume), scratchpad state, and catalog browser choices |
| `sqlservice.go` | The service behind the SQL scratchpad |
| `clients.go` | Per-profile Databricks API clients shared by the services |
| `internal/sqlexec` | Runs one statement through the Statement Execution API |
| `internal/queries` | Query files and run history |
| `workspacefiles.go` | Saving, opening and browsing `.sql` files in the workspace |
| `internal/wsfiles` | Local copies of workspace files and what they were last synced to |
| `frontend/src` | React UI |
| `frontend/bindings` | Generated TypeScript bindings; do not edit |

## Where data lives

- Profiles: `~/.databrickscfg` (or `DATABRICKS_CONFIG_FILE`)
- App settings: `settings.json` in the per-user config folder under `dbx-desktop` (or `DBX_DESKTOP_CONFIG_DIR`)
- Query files: `Documents/dbx-desktop/<profile>/`, or wherever you open them from
- Query history: `history/<profile>.jsonl` next to `settings.json`
- Local copies of workspace files: `workspace/<profile>/` next to `settings.json`. They hold edits until you save them to the workspace
- OAuth tokens: the Databricks CLI's own token cache. The app stores no credentials.
