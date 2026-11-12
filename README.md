# dbx-desktop

A desktop companion for Databricks. `dbx-desktop` is a working codename. The agreed design is in [SPEC.md](SPEC.md).

Built with [Wails v3](https://v3.wails.io/): a Go backend using the official Databricks Go SDK, and a React and TypeScript frontend rendered in the OS webview.

## Status

Pillar 1, the workspace hub, is built:

- Profile manager over `~/.databrickscfg`: add, remove, set the CLI default
- Browser OAuth sign-in through the Databricks CLI, or a personal access token
- Workspace switcher with per-workspace color, nickname and production flag
- Overview for the active workspace: failed runs in the past 24 hours and SQL warehouse states

Cloud status is available from the sidebar, including before adding a workspace:

- Choose AWS, Azure or GCP and watch one or more regions across providers
- The sidebar indicator summarizes only watched regions: green for operational, amber for maintenance or degradation, red for disruptions or security events, and gray when status is unavailable or outdated
- Inspect each region's services, active incidents and scheduled maintenance, or open the official Databricks status page
- Choices persist in app settings. Public status feeds refresh every five minutes without workspace credentials. Failed checks keep the last details visible but mark them unavailable

Desktop settings are available from the sidebar and tray menu:

- **Keep running in system tray when closed** is on by default. Closing the window hides it, preserving running queries, notebook run chains, results and Python sessions. Open it again from the Windows system tray or macOS menu bar. Choose **Quit dbx-desktop** in that menu to exit and end notebook sessions. Turn the setting off to make closing the window quit
- Enable **Notify when queries and notebook runs finish** to request system notification permission. Notifications report success or failure while the app is in the background; cancelled runs stay silent. Run all and Run from here send one notification when the chain ends, rather than one per cell
- Clicking a completion notification opens the original workspace and tab. Opened SQL and notebook views retain results when switching workspaces. Notification text contains the profile and filename, without SQL, results or error details
- **Send test notification** checks delivery even while the app is focused. System notification and Focus settings still apply. macOS notifications require a packaged, signed app; an unavailable notification service does not prevent using the rest of the app

Desktop validation: an isolated macOS app with a simulated Databricks API kept a query running after closing the window, restored its result, retained it across workspace switches, and exited on close when the tray setting was off. Notification permission was rejected for the temporary ad-hoc-signed bundle; actual delivery and clicking a system notification still need a signed-build check. Notification routing, focus suppression, cancellation and permission failures have automated coverage. The Windows build compiles, but tray behavior and notification delivery have not been checked on Windows.

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

Notebooks, for Python on all-purpose (data engineering) clusters or serverless compute, are built:

- Notebooks are Python files in Databricks source format (`# COMMAND ----------` between cells), so they round-trip with workspace notebooks and Git folders
- Scratch notebooks live in `Documents/dbx-desktop/<profile>/notebooks/`; open any `.py` from disk or drop one on the window
- The Workspace panel lists Python notebooks in Databricks. Open one, edit it, and save it back with Cmd/Ctrl+S, with the same change-conflict check as SQL files. Cell outputs are not saved
- Python, SQL (`%sql`) and Markdown (`%md`) cells. SQL cells run through `spark.sql` in the notebook's Python session, so they see temporary views made in Python. Other magics (`%sh`, `%run`, `%fs`, Scala, R, and `%pip` on clusters) are refused with an explanation
- The Compute picker offers Serverless and the workspace's all-purpose clusters. Each open notebook gets its own Python session, so variables carry from cell to cell. Closing the notebook, End session, switching compute, or quitting the app ends it
- On a cluster, cells run on the cluster through the Command Execution API
- On serverless, cells run in a local Python process with Databricks Connect: Spark and SQL run on serverless compute, and other Python (pandas, loops, prints) runs on this computer. Databricks has no public API for a remote Python session on serverless. The first time, Set up creates a local environment with uv (Python plus the databricks-connect release that matches the chosen serverless environment version, 2 to 5, default 4) under `python/` next to `settings.json`. uv must be installed; the app shows how. `%pip install` cells install into that local environment
- Cmd/Ctrl+Enter runs a cell, Shift+Enter runs it and moves on, Run all stops at the first error, and Stop cancels the running cell on the cluster
- Outputs: printed text, tables from `display()` (up to 10,000 rows), plots, and errors with the traceback
- The cluster picker lists all-purpose clusters (not job or pipeline clusters) with state, runtime and access mode, and can start a terminated one
- On a production workspace, the first run of a notebook on a cluster asks first; data-changing `%sql` cells ask as in the SQL scratchpad
- If the cluster restarts, the next run says the session was lost and starts a new one, rather than running against missing variables

Serverless notebooks were tested end to end against the development workspace. Cluster notebooks were not: cells have only been tested against a simulated API, because the development workspace has no classic clusters. Before relying on it, check on a real cluster that `display()` returns tables, that plots come back, and how standard (shared) access mode behaves. See [notebook execution research](.wayfinder/research/notebook-execution.md).

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
| `desktopservice.go`, `trayicon.go` | Tray menu, close behavior, desktop preferences and native completion notifications |
| `workspaceservice.go` | The service the frontend calls: profiles, sign-in, overview |
| `cloudstatusservice.go`, `internal/cloudstatus` | Public Databricks status feeds, regional health and watched regions |
| `internal/dbcfg` | Reads and writes `~/.databrickscfg`, with a `.bak` backup on every write |
| `internal/dbcli` | Finds the Databricks CLI and runs its browser login |
| `internal/settings` | App-only metadata (color, nickname, production flag, default volume), scratchpad state, and catalog browser choices |
| `sqlservice.go` | The service behind the SQL scratchpad |
| `clients.go` | Per-profile Databricks API clients shared by the services |
| `internal/sqlexec` | Runs one statement through the Statement Execution API |
| `internal/queries` | Query files and run history |
| `workspacefiles.go` | Saving, opening and browsing `.sql` files in the workspace |
| `internal/wsfiles` | Local copies of workspace files and notebooks and what they were last synced to |
| `notebookservice.go` | The service behind notebooks: files, clusters, running cells, workspace notebooks |
| `internal/nbexec` | Runs Python on a cluster through the Command Execution API and keeps one session per notebook |
| `serverless.go`, `internal/pykernel` | Serverless notebooks: the local Python environments and one Databricks Connect process per notebook |
| `frontend/src` | React UI |
| `frontend/bindings` | Generated TypeScript bindings; do not edit |

## Where data lives

- Profiles: `~/.databrickscfg` (or `DATABRICKS_CONFIG_FILE`)
- App settings: `settings.json` in the per-user config folder under `dbx-desktop` (or `DBX_DESKTOP_CONFIG_DIR`)
- Query files: `Documents/dbx-desktop/<profile>/`, and notebooks in its `notebooks` folder, or wherever you open them from
- Query history: `history/<profile>.jsonl` next to `settings.json`
- Local copies of workspace files: `workspace/<profile>/` next to `settings.json`, and of workspace notebooks: `notebooks/<profile>/`. They hold edits until you save them to the workspace
- OAuth tokens: the Databricks CLI's own token cache. The app stores no credentials.
