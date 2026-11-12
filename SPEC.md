# dbx-desktop spec

Agreed design from the discovery interview on 2026-11-11. `dbx-desktop` is a working codename.

## Purpose

A native desktop companion for Databricks. It exists to fix four problems:

1. Databricks work gets lost among browser tabs.
2. Using local files (flat files, SQL, notebooks) with Databricks has too much friction.
3. With several workspaces, it is unclear which one is active.
4. `~/.databrickscfg` has to be maintained by hand in a text editor.

It is not a replica of the Databricks web UI. It covers a chosen set of features well, and everything else gets an "Open in Databricks" link.

## Audience and success

- First user: the author, a data and platform architect who writes jobs and pipelines, runs SQL analysis, and cares about cost and governance.
- Later: possibly an internal open-source tool at the author's company. Users are technically proficient.
- Success: the author uses it daily on a Windows work laptop instead of browser tabs.
- Secondary goal: learn how to build, integrate and distribute a desktop app inside an organization.

## Naming and branding

- `dbx-desktop` is the codename only. Pick a distinct public name before anyone else gets a copy.
- No Databricks logo or trademarks in the app's identity. "for Databricks" as a descriptor is fine.
- Theme is inspired by the Databricks palette (dark navy, warm off-white, orange-red accent), in light and dark modes.

## Stack

- **Shell:** Wails, using the OS webview (WKWebView on macOS, WebView2 on Windows). No bundled Chromium. Check Wails v3 against v2 stability when scaffolding.
- **Backend:** Go, with the official Databricks Go SDK for all data calls.
- **Frontend:** React and TypeScript.
- **Databricks CLI:** required. The app detects it at startup and shows install instructions if it is missing. Used for login (`databricks auth login`) and folder sync. Not bundled with the app.
- **Platforms:** macOS (development target) and Windows (daily-use target). CI builds a portable Windows `.exe` from the first milestone. Keep all code portable.

## Auth and configuration

- `~/.databrickscfg` is the single source of truth for profiles. The app is a GUI over it: add, edit, remove.
- Login is browser OAuth by default. "Add workspace" takes a workspace URL and runs the browser sign-in. No token is written to the config file.
- Personal access tokens are supported the standard way: the app writes them to `~/.databrickscfg`. Profiles holding a plaintext token are flagged, with a one-click "switch to OAuth".
- OS keychain storage for tokens is deferred, because the CLI and SDKs cannot read from it.
- App-only metadata (color, nickname, prod flag, default volume) lives in the per-user config folder for each OS, not in `.databrickscfg`.

## Design rules

- Single window, one active workspace at a time. The workspace color and nickname are always visible.
- Workspaces can be flagged as production. Destructive or costly actions need confirmation everywhere, with a stricter check on prod-flagged workspaces.
- The app talks only to the user's Databricks workspace hosts. No telemetry, no third-party network calls.
- The app keeps no credential store of its own.
- Refresh by polling about once a minute while the window is open. No background process after the window closes.

## v1 pillars, in build order

### 1. Workspace hub
- Profile manager over `~/.databrickscfg`
- Browser OAuth login
- Workspace switcher, per-workspace color and nickname, prod flag
- Launch screen: overview of the last active workspace (failed runs in the past 24 hours, running warehouses, recent queries, linked local projects)

### 2. SQL scratchpad
- Multiple query tabs, each backed by a plain `.sql` file in a visible folder (default `Documents/dbx-desktop/<workspace>/`)
- Open or drop a local `.sql` file and run it on a warehouse
- Catalog, schema and table tree with click-to-insert
- Warehouse picker showing state, with start and stop
- Results grid capped at about 10,000 rows, with CSV export
- Per-workspace query history

### 3. File drop
- Drop a local file to upload it to a Unity Catalog volume
- A default volume can be set per workspace
- Optional "create table from this file" step using `read_files` on a warehouse, with a schema preview
- CSV, Parquet and JSON

### 4. Jobs and pipelines monitor
- Runs feed filtered by failed, running, or mine
- Run detail with per-task status and error message
- Re-run, repair and cancel
- Pipelines list with latest update state and a start button
- Native OS notification when a starred job fails
- No job or pipeline authoring

### 5. Local projects
Link a local folder to a workspace location.
- **Git mode:** when the folder is a git repo matched to a Databricks Git folder, one button updates the Git folder to the pushed branch. Shows local branch against workspace branch and any drift. Commit and push stay in the user's own git tools.
- **Scratch mode:** no git. One-way sync from the local folder to a workspace path, with an optional watch toggle.

## Viability checkpoint

After pillars 1 and 2, the author uses the app for a week on the Windows work laptop against work workspaces. Work continues only if it replaced the browser for that work.

## Deferred

- v1.1: run a local `.py` file or notebook as a one-time serverless job, with logs streamed back
- v2, first item: cost, permissions and governance views built on system tables
- Menu-bar or tray presence
- SQL autocomplete, charts, query parameters
- Excel import
- Declarative Automation Bundles support
- Multi-window, one per workspace
- Code signing, installers and auto-update (needed before internal rollout)

## Environment

- Development workspace: the author's Databricks Free Edition workspace (the `DEFAULT` profile). It is serverless-only with one small warehouse, so classic clusters and account-level features cannot be tested there.
- Work workspaces are treated as prod-flagged from the day they are added.
- No git repository yet. It will start on the author's personal GitHub.

## Open risks

No smoke test was run on the work laptop, by choice. The first Windows build is where these get answered:

- Whether the laptop will run an unsigned `.exe`
- Whether browser OAuth login is allowed on the work workspaces
- Whether the network or proxy lets a desktop app reach Databricks
- Whether the CLI is installed or installable there

It is also assumed that pointing the app at work workspaces is the author's to approve.
