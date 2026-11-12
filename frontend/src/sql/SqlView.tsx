import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { SQLService, type QueryTab, type RemoteFile, type Warehouse, type Workspace } from "../../bindings/dbx-desktop";
import type { File as QueryFile, HistoryEntry } from "../../bindings/dbx-desktop/internal/queries/models";
import type { Result } from "../../bindings/dbx-desktop/internal/sqlexec/models";
import { ConfirmDialog } from "../dialogs";
import { displayName, errorText, relativeTime, shortHost, stateLabel } from "../lib";
import { classify, needsConfirm, type Risk } from "../sqlsplit";
import { CatalogTree } from "./CatalogTree";
import { toCSV } from "./csv";
import { Editor, type EditorHandle } from "./Editor";
import { ResultsGrid } from "./ResultsGrid";
import { PlaceBanner, ScratchPanel } from "./ScratchFiles";
import { ConflictDialog, SaveToWorkspaceDialog, WorkspacePanel, WsIcon } from "./WorkspaceFiles";
import { suggestedName } from "./wspath";

interface Tab {
  path: string;
  name: string;
  content: string;
  /** True while the editor holds changes not yet written to the file. */
  dirty: boolean;
  /** Set when the file is the local copy of a workspace file. */
  remote?: RemoteFile;
}

function toTab(t: QueryTab): Tab {
  return { path: t.file.path, name: t.file.name, content: t.content, dirty: false, remote: t.remote ?? undefined };
}

interface Run {
  runId: string;
  statement: string;
  startedAt: number;
  result?: Result;
}

type Side = "catalog" | "scratch" | "workspace" | "history";

const SIDE_LABELS: Record<Side, string> = {
  catalog: "Catalog",
  scratch: "Scratch",
  workspace: "Workspace",
  history: "History",
};

type Ask =
  | { kind: "run"; statement: string; risk: Risk }
  | { kind: "start"; wh: Warehouse }
  | { kind: "stop"; wh: Warehouse }
  | { kind: "save"; path: string; name: string }
  | { kind: "conflict"; path: string; missing: boolean }
  | { kind: "revert"; path: string }
  | { kind: "delete"; paths: string[] }
  | null;

const SAVE_DELAY_MS = 700;
const WAREHOUSE_REFRESH_MS = 30_000;
const isMac = navigator.userAgent.includes("Mac");
const RUN_KEYS = isMac ? "⌘ Return" : "Ctrl+Enter";
const FORMAT_KEYS = isMac ? "⇧⌥F" : "Shift+Alt+F";
const SAVE_KEYS = isMac ? "⌘S" : "Ctrl+S";

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function Elapsed(props: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  return <>{Math.floor((Date.now() - props.since) / 1000)} s</>;
}

export function SqlView(props: { workspace: Workspace; visible: boolean }) {
  const ws = props.workspace;
  const profile = ws.profile.name;

  const [loaded, setLoaded] = useState(false);
  const [dir, setDir] = useState("");
  /** True when deleted scratch files go to the system trash. */
  const [hasTrash, setHasTrash] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState("");
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [warehouseError, setWarehouseError] = useState("");
  const [side, setSide] = useState<Side>("catalog");
  const [files, setFiles] = useState<QueryFile[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [ask, setAsk] = useState<Ask>(null);
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  /** Paths of tabs being uploaded to the workspace. */
  const [pushing, setPushing] = useState<string[]>([]);
  /** Bumped after each workspace save so the Workspace panel refreshes. */
  const [wsKey, setWsKey] = useState(0);

  const editor = useRef<EditorHandle>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const activeTab = tabs.find((t) => t.path === active);
  const run = active ? runs[active] : undefined;
  const warehouse = warehouses.find((w) => w.id === warehouseId);

  // ---------- Loading ----------

  const loadWarehouses = useCallback(async () => {
    try {
      const list = (await SQLService.ListWarehouses(profile)) ?? [];
      setWarehouses(list);
      setWarehouseError("");
      return list;
    } catch (e) {
      setWarehouseError(errorText(e));
      return [];
    }
  }, [profile]);

  const loadHistory = useCallback(() => {
    SQLService.History(profile)
      .then((h) => setHistory(h ?? []))
      .catch(() => {});
  }, [profile]);

  const loadFiles = useCallback(() => {
    SQLService.ListQueryFiles(profile)
      .then((f) => setFiles(f ?? []))
      .catch(() => {});
  }, [profile]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const st = await SQLService.State(profile);
        if (!live) return;
        let open = (st.tabs ?? []).map(toTab);
        if (open.length === 0) {
          const t = await SQLService.NewQueryFile(profile);
          if (!live) return;
          open = [{ path: t.file.path, name: t.file.name, content: "", dirty: false }];
        }
        setDir(st.dir);
        setHasTrash(st.trash);
        setTabs(open);
        setActive(open.some((t) => t.path === st.activeTab) ? st.activeTab : open[0].path);
        const list = await loadWarehouses();
        if (!live) return;
        const saved = list.find((w) => w.id === st.warehouseId);
        setWarehouseId((saved ?? list[0])?.id ?? "");
      } catch (e) {
        if (live) setNotice(errorText(e));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    loadHistory();
    return () => {
      live = false;
    };
  }, [profile, loadWarehouses, loadHistory]);

  useEffect(() => {
    if (!props.visible) return;
    const t = setInterval(loadWarehouses, WAREHOUSE_REFRESH_MS);
    return () => clearInterval(t);
  }, [props.visible, loadWarehouses]);

  // Remember which tabs are open and which warehouse is chosen.
  const tabPaths = tabs.map((t) => t.path).join("\n");
  useEffect(() => {
    if (!loaded) return;
    SQLService.SaveState(profile, warehouseId, tabPaths ? tabPaths.split("\n") : [], active).catch(() => {});
  }, [loaded, profile, warehouseId, tabPaths, active]);

  useEffect(() => {
    if (side === "scratch") loadFiles();
  }, [side, tabPaths, loadFiles]);

  // ---------- Saving ----------

  const saveNow = useCallback(async (path: string) => {
    const timer = timers.current.get(path);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(path);
    }
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || !tab.dirty) return;
    const content = tab.content;
    try {
      await SQLService.WriteQueryFile(path, content);
      setTabs((ts) => ts.map((t) => (t.path === path && t.content === content ? { ...t, dirty: false } : t)));
    } catch (e) {
      setNotice(`Could not save ${tab.name}: ${errorText(e)}`);
    }
  }, []);

  const onChange = useCallback(
    (path: string, content: string) => {
      setTabs((ts) =>
        ts.map((t) =>
          t.path === path
            ? { ...t, content, dirty: true, remote: t.remote && { ...t.remote, unsaved: true } }
            : t,
        ),
      );
      const old = timers.current.get(path);
      if (old) clearTimeout(old);
      timers.current.set(
        path,
        setTimeout(() => saveNow(path), SAVE_DELAY_MS),
      );
    },
    [saveNow],
  );

  // Write out anything unsaved when the view goes away.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of tabsRef.current) {
        if (t.dirty) SQLService.WriteQueryFile(t.path, t.content).catch(() => {});
      }
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  // ---------- Tabs ----------

  const openPath = useCallback(async (path: string) => {
    if (tabsRef.current.some((t) => t.path === path)) {
      setActive(path);
      return;
    }
    try {
      const t = await SQLService.OpenQueryFile(path);
      setTabs((ts) =>
        ts.some((x) => x.path === t.file.path)
          ? ts
          : [...ts, { path: t.file.path, name: t.file.name, content: t.content, dirty: false }],
      );
      setActive(t.file.path);
    } catch (e) {
      setNotice(errorText(e));
    }
  }, []);

  const newTab = async () => {
    try {
      const t = await SQLService.NewQueryFile(profile);
      setTabs((ts) => [...ts, { path: t.file.path, name: t.file.name, content: "", dirty: false }]);
      setActive(t.file.path);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  // ---------- Workspace files ----------

  /** Opens a workspace file, or switches to its tab when it is already open. */
  const openRemote = async (remotePath: string) => {
    const open = tabsRef.current.find((t) => t.remote?.path === remotePath);
    if (open) {
      setActive(open.path);
      return;
    }
    try {
      const t = toTab(await SQLService.OpenFromWorkspace(profile, remotePath));
      setTabs((ts) => (ts.some((x) => x.path === t.path) ? ts : [...ts, t]));
      setActive(t.path);
      setNotice(t.remote?.unsaved ? `${t.name} has edits from earlier that are not saved to the workspace.` : "");
      setWsKey((n) => n + 1);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  /** Moves a tab to a new file, keeping its editor state and last result. */
  const moveTab = (oldPath: string, t: Tab) => {
    // A tab already showing the new file is replaced; its content was just overwritten.
    if (oldPath !== t.path && tabsRef.current.some((x) => x.path === t.path)) editor.current?.forget(t.path);
    editor.current?.rename(oldPath, t.path);
    setTabs((ts) =>
      ts
        .filter((x) => x.path !== t.path || x.path === oldPath)
        .map((x) => (x.path === oldPath ? { ...x, path: t.path, name: t.name, remote: t.remote } : x)),
    );
    setRuns((rs) => {
      if (!rs[oldPath] || oldPath === t.path) return rs;
      const { [oldPath]: moved, ...others } = rs;
      return { ...others, [t.path]: moved };
    });
    setActive((a) => (a === oldPath ? t.path : a));
  };

  const setRemote = (path: string, remote: RemoteFile) =>
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, remote } : t)));

  /** ⌘S: saves a workspace file back, or asks where to save a scratch query. */
  const saveToWorkspace = async (path: string, force = false) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || pushing.includes(path)) return;
    await saveNow(path);
    if (!tab.remote) {
      setAsk({ kind: "save", path, name: suggestedName(tab.name) });
      return;
    }
    const content = tabsRef.current.find((t) => t.path === path)?.content;
    setPushing((p) => [...p, path]);
    try {
      const res = await SQLService.PushToWorkspace(profile, path, force);
      if (res.status === "saved" && res.remote) {
        // Edits typed while the upload ran are still unsaved.
        const latest = tabsRef.current.find((t) => t.path === path)?.content;
        setRemote(path, { ...res.remote, unsaved: latest !== content });
        setNotice("");
        setWsKey((n) => n + 1);
      } else {
        setAsk({ kind: "conflict", path, missing: res.status === "missing" });
      }
    } catch (e) {
      setNotice(`Could not save ${tab.name} to the workspace: ${errorText(e)}`);
    } finally {
      setPushing((p) => p.filter((x) => x !== path));
    }
  };

  /** Replaces a tab's text with the workspace version, discarding local edits. */
  const loadRemote = async (path: string) => {
    const timer = timers.current.get(path);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(path);
    }
    try {
      const t = toTab(await SQLService.ReloadFromWorkspace(profile, path));
      editor.current?.replace(path, t.content);
      setTabs((ts) => ts.map((x) => (x.path === path ? { ...x, content: t.content, dirty: false, remote: t.remote } : x)));
      setNotice("");
      setWsKey((n) => n + 1);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  /** Deletes scratch files and closes their tabs without saving them again. */
  const deleteFiles = async (paths: string[]) => {
    for (const p of paths) {
      const timer = timers.current.get(p);
      if (timer) clearTimeout(timer);
      timers.current.delete(p);
    }
    try {
      const res = await SQLService.DeleteQueryFiles(profile, paths);
      const gone = new Set(res.deleted ?? []);
      if (gone.size > 0) {
        const list = tabsRef.current;
        const rest = list.filter((t) => !gone.has(t.path));
        // Drop the tabs now so nothing writes the files back.
        tabsRef.current = rest;
        setTabs(rest);
        gone.forEach((p) => editor.current?.forget(p));
        setRuns((rs) => Object.fromEntries(Object.entries(rs).filter(([k]) => !gone.has(k))));
        if (gone.has(active)) {
          const idx = list.findIndex((t) => t.path === active);
          const next = list.slice(idx + 1).find((t) => !gone.has(t.path)) ?? [...list.slice(0, idx)].reverse().find((t) => !gone.has(t.path));
          setActive(next?.path ?? "");
        }
      }
      const errors = res.errors ?? [];
      setNotice(errors.length ? `Could not delete ${errors.length === 1 ? "a file" : `${errors.length} files`}: ${errors.join("; ")}` : "");
    } catch (e) {
      setNotice(errorText(e));
    }
    loadFiles();
  };

  const saveRef = useRef(saveToWorkspace);
  saveRef.current = saveToWorkspace;
  useEffect(() => {
    if (!props.visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s" || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (document.querySelector("dialog[open]") || !active) return;
      saveRef.current(active);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.visible, active]);

  const pickFile = async () => {
    try {
      const path = await SQLService.PickQueryFile();
      if (path) await openPath(path);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  const closeTab = async (path: string) => {
    await saveNow(path);
    const list = tabsRef.current;
    const closing = list.find((t) => t.path === path);
    if (closing?.remote?.unsaved) {
      setNotice(
        `${closing.name} has edits that are not saved to the workspace. They are kept on this computer and come back when you open it again.`,
      );
    }
    if (closing?.remote) setWsKey((n) => n + 1);
    const idx = list.findIndex((t) => t.path === path);
    const rest = list.filter((t) => t.path !== path);
    setTabs(rest);
    editor.current?.forget(path);
    if (active === path) setActive((rest[idx] ?? rest[idx - 1])?.path ?? "");
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { path, value } = renaming;
    setRenaming(null);
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || !value.trim() || value.trim() === tab.name) return;
    await saveNow(path);
    try {
      const f = await SQLService.RenameQueryFile(path, value);
      editor.current?.rename(path, f.path);
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, path: f.path, name: f.name } : t)));
      setRuns((rs) => {
        if (!rs[path]) return rs;
        const { [path]: moved, ...others } = rs;
        return { ...others, [f.path]: moved };
      });
      if (active === path) setActive(f.path);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  // Files dropped on the window: open the .sql ones here.
  useEffect(() => {
    if (!props.visible) return;
    const off = Events.On("files-dropped", (ev: { data: unknown }) => {
      const paths = Array.isArray(ev.data) ? (ev.data as string[]) : [];
      const sqlFiles = paths.filter((p) => typeof p === "string" && p.toLowerCase().endsWith(".sql"));
      if (sqlFiles.length === 0) {
        if (paths.length) setNotice("Only .sql files can be opened in the scratchpad.");
        return;
      }
      sqlFiles.forEach((p) => openPath(p));
    });
    return () => off();
  }, [props.visible, openPath]);

  // ---------- Running ----------

  const execute = async (statement: string) => {
    const path = active;
    if (!path) return;
    await saveNow(path);
    const runId = crypto.randomUUID();
    setRuns((rs) => ({ ...rs, [path]: { runId, statement, startedAt: Date.now() } }));
    let result: Result;
    try {
      result = await SQLService.RunQuery(profile, warehouseId, statement, runId);
    } catch (e) {
      result = { statementId: "", status: "FAILED", columns: [], rows: [], truncated: false, error: errorText(e), durationMs: 0 };
    }
    // The tab may have been renamed while the query ran; find the run by its id.
    setRuns((rs) => {
      const key = Object.keys(rs).find((k) => rs[k].runId === runId);
      return key ? { ...rs, [key]: { ...rs[key], result } } : rs;
    });
    loadHistory();
    loadWarehouses();
  };

  const runQuery = () => {
    if (run && !run.result) return; // one statement at a time per tab
    const statement = editor.current?.runTarget() ?? "";
    if (!statement) {
      setNotice("There is no statement to run.");
      return;
    }
    if (!warehouseId) {
      setNotice("Choose a SQL warehouse first.");
      return;
    }
    setNotice("");
    const risk = classify(statement);
    if (needsConfirm(risk, ws.meta.prod)) {
      setAsk({ kind: "run", statement, risk });
    } else {
      execute(statement);
    }
  };

  const formatQuery = () => {
    try {
      editor.current?.format();
      setNotice("");
    } catch (e) {
      setNotice(`Could not format: ${errorText(e).split("\n")[0]}`);
    }
  };

  const exportCSV = async () => {
    const res = run?.result;
    if (!res || !activeTab) return;
    const csv = toCSV(res.columns ?? [], res.rows ?? []);
    const name = activeTab.name.replace(/\.sql$/i, "") + ".csv";
    try {
      const saved = await SQLService.SaveTextFile(name, csv);
      if (saved) setNotice(`Saved ${saved}`);
    } catch {
      // No native dialog (for example when running in a browser): download instead.
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // ---------- Warehouses ----------

  const warehouseAction = async (kind: "start" | "stop", wh: Warehouse) => {
    try {
      if (kind === "start") await SQLService.StartWarehouse(profile, wh.id);
      else await SQLService.StopWarehouse(profile, wh.id);
      setNotice("");
    } catch (e) {
      setNotice(errorText(e));
    }
    await loadWarehouses();
  };

  const running = !!run && !run.result;
  const result = run?.result;
  const rowCount = result?.rows?.length ?? 0;
  const canStart = warehouse && (warehouse.state === "STOPPED" || warehouse.state === "STOPPING");
  const canStop = warehouse && (warehouse.state === "RUNNING" || warehouse.state === "STARTING");

  return (
    <div className="sql" data-file-drop-target>
      <aside className="side" aria-label="Browser">
        <div className="side-tabs" role="tablist">
          {(Object.keys(SIDE_LABELS) as Side[]).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)}>
              {SIDE_LABELS[s]}
            </button>
          ))}
        </div>
        {side === "catalog" && <CatalogTree profile={profile} onInsert={(t) => editor.current?.insert(t)} />}
        {side === "workspace" && (
          <>
            <PlaceBanner kind="workspace" title="Workspace" detail={shortHost(ws.profile.host)}>
              Files stored in Databricks. Edits stay on this computer until you save with {SAVE_KEYS}.
            </PlaceBanner>
            <WorkspacePanel profile={profile} reloadKey={wsKey} current={activeTab?.remote?.path} onOpen={openRemote} />
          </>
        )}
        {side === "scratch" && (
          <>
            <PlaceBanner kind="scratch" title="Scratch" detail={dir} detailTitle={dir}>
              Local drafts on this computer, saved as you type. Not in Databricks until you save one to the workspace.
            </PlaceBanner>
            <div className="side-body">
              <ScratchPanel
                files={files}
                current={activeTab && !activeTab.remote ? activeTab.path : undefined}
                onOpen={openPath}
                onDelete={(paths) => paths.length && setAsk({ kind: "delete", paths })}
              />
              <div className="scratch-foot">
                <button className="link" onClick={pickFile}>
                  Open a .sql file from elsewhere…
                </button>
              </div>
            </div>
          </>
        )}
        {side === "history" && (
          <div className="side-body">
            <div className="side-tools">
              <span className="muted">Click an entry to insert it.</span>
            </div>
            {history.length === 0 ? (
              <div className="tree-note">Nothing has been run in this workspace yet.</div>
            ) : (
              <ul className="side-list history">
                {history.map((h, i) => (
                  <li key={`${h.time}-${i}`}>
                    <button onClick={() => editor.current?.insert(h.statement)} title={h.statement}>
                      <span className="mono stmt">{h.statement}</span>
                      <span className="tree-hint">
                        <span className={h.status === "SUCCEEDED" ? "ok-text" : "bad-text"}>
                          {stateLabel(h.status)}
                        </span>
                        {h.status === "SUCCEEDED" ? ` · ${h.rowCount.toLocaleString()} rows` : ""} ·{" "}
                        {relativeTime(h.time)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      <section className="work">
        <div className="tabstrip" role="tablist" aria-label="Open queries">
          {tabs.map((t) => (
            <div
              key={t.path}
              className="qtab"
              role="tab"
              aria-selected={t.path === active}
              title={t.remote ? `Workspace: ${t.remote.path}` : t.path}
            >
              {renaming?.path === t.path ? (
                <input
                  className="qtab-input"
                  autoFocus
                  aria-label="File name"
                  value={renaming.value}
                  onChange={(e) => setRenaming({ path: t.path, value: e.target.value })}
                  onFocus={(e) => {
                    // Preselect the name without its extension, ready to overtype.
                    const dot = e.target.value.toLowerCase().lastIndexOf(".sql");
                    e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
                  }}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button
                  className="qtab-name"
                  onClick={() => setActive(t.path)}
                  onDoubleClick={() => !t.remote && setRenaming({ path: t.path, value: t.name })}
                >
                  {t.remote && <WsIcon kind="cloud" className="qtab-ws" />}
                  <span className="qtab-label">{t.name}</span>
                  {t.remote?.unsaved ? (
                    <span
                      className="unsaved remote"
                      title={`Not saved to the workspace. ${SAVE_KEYS} saves it.`}
                      aria-label="not saved to the workspace"
                    >
                      {" "}
                      ●
                    </span>
                  ) : (
                    t.dirty && (
                      <span className="unsaved" title="Saving…" aria-label="unsaved changes">
                        {" "}
                        ●
                      </span>
                    )
                  )}
                </button>
              )}
              <button className="qtab-close" aria-label={`Close ${t.name}`} onClick={() => closeTab(t.path)}>
                ×
              </button>
            </div>
          ))}
          <button className="qtab-add" onClick={newTab} aria-label="New query" title="New query">
            ＋
          </button>
        </div>

        <div className="toolbar">
          <button className="btn primary" onClick={runQuery} disabled={!activeTab || running}>
            Run <span className="keys">{RUN_KEYS}</span>
          </button>
          {running && (
            <button className="btn" onClick={() => SQLService.CancelQuery(run!.runId)}>
              Cancel
            </button>
          )}
          <button
            className="btn"
            onClick={formatQuery}
            disabled={!activeTab}
            title="Format the selection, or the whole query when nothing is selected"
          >
            Format <span className="keys">{FORMAT_KEYS}</span>
          </button>
          {activeTab?.remote ? (
            <>
              <button
                className="btn"
                onClick={() => saveToWorkspace(activeTab.path)}
                disabled={!activeTab.remote.unsaved || pushing.includes(activeTab.path)}
                title={`Save to ${activeTab.remote.path}`}
              >
                {pushing.includes(activeTab.path) ? "Saving…" : "Save"} <span className="keys">{SAVE_KEYS}</span>
              </button>
              <span className="ws-status" title={activeTab.remote.path}>
                {activeTab.remote.unsaved ? (
                  <>
                    Not saved to workspace ·{" "}
                    <button className="link" onClick={() => setAsk({ kind: "revert", path: activeTab.path })}>
                      Discard
                    </button>
                  </>
                ) : (
                  <>Saved to workspace {relativeTime(activeTab.remote.modifiedAt)}</>
                )}
              </span>
            </>
          ) : (
            <button
              className="btn"
              onClick={() => activeTab && saveToWorkspace(activeTab.path)}
              disabled={!activeTab}
              title="Keep this query as a file in the Databricks workspace"
            >
              Save to workspace… <span className="keys">{SAVE_KEYS}</span>
            </button>
          )}
          <span className="toolbar-gap" />
          <label className="muted" htmlFor="wh-select">
            Warehouse
          </label>
          <select
            id="wh-select"
            aria-label="Warehouse"
            className="input select"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            disabled={warehouses.length === 0}
          >
            {warehouses.length === 0 && <option value="">{warehouseError ? "Unavailable" : "None found"}</option>}
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.size ? ` (${w.size})` : ""}
              </option>
            ))}
          </select>
          {warehouse && (
            <span className={warehouse.state === "RUNNING" ? "badge warn" : "badge"}>{stateLabel(warehouse.state)}</span>
          )}
          {canStart && (
            <button
              className="btn small"
              onClick={() => (ws.meta.prod ? setAsk({ kind: "start", wh: warehouse }) : warehouseAction("start", warehouse))}
            >
              Start
            </button>
          )}
          {canStop && (
            <button className="btn small" onClick={() => setAsk({ kind: "stop", wh: warehouse })}>
              Stop
            </button>
          )}
        </div>

        {(notice || warehouseError) && (
          <div className="sql-notice" role="status">
            <span>{notice || warehouseError}</span>
            {notice && (
              <button className="link" onClick={() => setNotice("")}>
                Dismiss
              </button>
            )}
          </div>
        )}

        <div className="editor-pane">
          {activeTab ? (
            <Editor
              ref={editor}
              docKey={activeTab.path}
              initial={activeTab.content}
              onChange={onChange}
              onRun={runQuery}
              onFormat={formatQuery}
            />
          ) : (
            <div className="empty">
              {loaded ? (
                <>
                  No query is open.{" "}
                  <button className="link" onClick={newTab}>
                    New query
                  </button>
                </>
              ) : (
                "Loading…"
              )}
            </div>
          )}
        </div>

        <div className="results-pane" aria-live="polite">
          {!run && (
            <div className="empty">
              Run a statement with {RUN_KEYS}. With nothing selected, the statement under the cursor runs.
            </div>
          )}
          {running && (
            <div className="result-status">
              <span className="spinner" aria-hidden="true" />
              <span>
                Running for <Elapsed since={run!.startedAt} />
              </span>
              <span className="muted mono stmt">{run!.statement}</span>
            </div>
          )}
          {result?.status === "FAILED" && (
            <div className="result-error" role="alert">
              <strong>The statement failed</strong>
              <pre>{result.error}</pre>
            </div>
          )}
          {result?.status === "CANCELED" && <div className="empty">The statement was cancelled.</div>}
          {result?.status === "SUCCEEDED" && (
            <>
              <div className="result-status">
                {(result.columns?.length ?? 0) > 0 ? (
                  <span>
                    <strong>{rowCount.toLocaleString()}</strong> {rowCount === 1 ? "row" : "rows"} ·{" "}
                    {seconds(result.durationMs)}
                  </span>
                ) : (
                  <span>
                    <strong>Succeeded</strong> · {seconds(result.durationMs)}
                  </span>
                )}
                {result.truncated && (
                  <span className="badge warn">Showing the first {rowCount.toLocaleString()} rows</span>
                )}
                <span className="toolbar-gap" />
                {(result.columns?.length ?? 0) > 0 && (
                  <button className="btn small" onClick={exportCSV}>
                    Export CSV
                  </button>
                )}
              </div>
              {(result.columns?.length ?? 0) > 0 ? (
                <ResultsGrid columns={result.columns ?? []} rows={result.rows ?? []} />
              ) : (
                <div className="empty">The statement returned no result set.</div>
              )}
            </>
          )}
        </div>
      </section>

      {ask?.kind === "run" && (
        <ConfirmDialog
          title={ask.risk === "destructive" ? "Run this destructive statement?" : "Run this statement on production?"}
          confirmLabel="Run statement"
          danger
          requireText={ws.meta.prod && ask.risk === "destructive" ? ws.profile.name : undefined}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const s = ask.statement;
            setAsk(null);
            execute(s);
          }}
        >
          <p>
            {ask.risk === "destructive"
              ? "This statement removes or replaces data or objects"
              : "This statement changes data or objects"}{" "}
            in <strong>{displayName(ws)}</strong>
            {ws.meta.prod ? ", a production workspace." : "."}
          </p>
          <pre className="confirm-sql">{ask.statement}</pre>
        </ConfirmDialog>
      )}
      {ask?.kind === "stop" && (
        <ConfirmDialog
          title={`Stop ${ask.wh.name}?`}
          confirmLabel="Stop warehouse"
          danger
          requireText={ws.meta.prod ? ws.profile.name : undefined}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const wh = ask.wh;
            setAsk(null);
            warehouseAction("stop", wh);
          }}
        >
          <p>
            Stopping the warehouse ends every query running on it, including other people's, in{" "}
            <strong>{displayName(ws)}</strong>.
          </p>
        </ConfirmDialog>
      )}
      {ask?.kind === "save" && (
        <SaveToWorkspaceDialog
          profile={profile}
          localPath={ask.path}
          defaultName={ask.name}
          onClose={() => setAsk(null)}
          onSaved={(t) => {
            const oldPath = ask.path;
            setAsk(null);
            moveTab(oldPath, toTab(t));
            setNotice("");
            setWsKey((n) => n + 1);
            if (side === "scratch") loadFiles();
          }}
        />
      )}
      {ask?.kind === "conflict" && (
        <ConflictDialog
          name={tabs.find((t) => t.path === ask.path)?.name ?? ""}
          remotePath={tabs.find((t) => t.path === ask.path)?.remote?.path ?? ""}
          missing={ask.missing}
          onClose={() => setAsk(null)}
          onOverwrite={() => {
            const path = ask.path;
            setAsk(null);
            saveToWorkspace(path, true);
          }}
          onLoadRemote={() => {
            const path = ask.path;
            setAsk(null);
            loadRemote(path);
          }}
        />
      )}
      {ask?.kind === "revert" && (
        <ConfirmDialog
          title="Discard your edits?"
          confirmLabel="Discard edits"
          danger
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const path = ask.path;
            setAsk(null);
            loadRemote(path);
          }}
        >
          <p>
            This replaces the query with the version saved in the workspace,{" "}
            <span className="mono">{tabs.find((t) => t.path === ask.path)?.remote?.path}</span>. You can undo it in the
            editor until you close the tab.
          </p>
        </ConfirmDialog>
      )}
      {ask?.kind === "delete" && (
        <DeleteDialog
          paths={ask.paths}
          names={ask.paths.map((p) => files.find((f) => f.path === p)?.name ?? p.split(/[\\/]/).pop() ?? p)}
          open={tabs.filter((t) => ask.paths.includes(t.path)).length}
          trash={hasTrash}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const paths = ask.paths;
            setAsk(null);
            deleteFiles(paths);
          }}
        />
      )}
      {ask?.kind === "start" && (
        <ConfirmDialog
          title={`Start ${ask.wh.name}?`}
          confirmLabel="Start warehouse"
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const wh = ask.wh;
            setAsk(null);
            warehouseAction("start", wh);
          }}
        >
          <p>
            A running warehouse is billed until it stops. This starts it in <strong>{displayName(ws)}</strong>, a
            production workspace.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function DeleteDialog(props: {
  paths: string[];
  names: string[];
  /** How many of the files are open in tabs. */
  open: number;
  trash: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const n = props.paths.length;
  const what = n === 1 ? props.names[0] : `${n} scratch files`;
  const shown = props.names.slice(0, 8);
  return (
    <ConfirmDialog
      title={props.trash ? `Move ${what} to the Trash?` : `Delete ${what}?`}
      confirmLabel={props.trash ? "Move to Trash" : "Delete"}
      danger
      onClose={props.onClose}
      onConfirm={props.onConfirm}
    >
      {n > 1 && (
        <ul className="delete-list mono">
          {shown.map((name, i) => (
            <li key={props.paths[i]}>{name}</li>
          ))}
          {n > shown.length && <li className="muted">and {n - shown.length} more</li>}
        </ul>
      )}
      <p>
        {props.trash ? `You can restore ${n === 1 ? "it" : "them"} from the Trash.` : "This cannot be undone."}{" "}
        {props.open > 0 &&
          (props.open === n && n === 1 ? "Its tab will close." : `${props.open} open ${props.open === 1 ? "tab" : "tabs"} will close.`)}
      </p>
    </ConfirmDialog>
  );
}
