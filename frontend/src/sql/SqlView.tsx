import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { SQLService, type Warehouse, type Workspace } from "../../bindings/dbx-desktop";
import type { File as QueryFile, HistoryEntry } from "../../bindings/dbx-desktop/internal/queries/models";
import type { Result } from "../../bindings/dbx-desktop/internal/sqlexec/models";
import { ConfirmDialog } from "../dialogs";
import { displayName, errorText, relativeTime, stateLabel } from "../lib";
import { classify, needsConfirm, type Risk } from "../sqlsplit";
import { CatalogTree } from "./CatalogTree";
import { toCSV } from "./csv";
import { Editor, type EditorHandle } from "./Editor";
import { ResultsGrid } from "./ResultsGrid";

interface Tab {
  path: string;
  name: string;
  content: string;
  /** True while the editor holds changes not yet written to the file. */
  dirty: boolean;
}

interface Run {
  runId: string;
  statement: string;
  startedAt: number;
  result?: Result;
}

type Side = "catalog" | "files" | "history";

type Ask =
  | { kind: "run"; statement: string; risk: Risk }
  | { kind: "start"; wh: Warehouse }
  | { kind: "stop"; wh: Warehouse }
  | null;

const SAVE_DELAY_MS = 700;
const WAREHOUSE_REFRESH_MS = 30_000;
const isMac = navigator.userAgent.includes("Mac");
const RUN_KEYS = isMac ? "⌘ Return" : "Ctrl+Enter";

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
        let open = (st.tabs ?? []).map((t) => ({
          path: t.file.path,
          name: t.file.name,
          content: t.content,
          dirty: false,
        }));
        if (open.length === 0) {
          const t = await SQLService.NewQueryFile(profile);
          if (!live) return;
          open = [{ path: t.file.path, name: t.file.name, content: "", dirty: false }];
        }
        setDir(st.dir);
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
    if (side === "files") loadFiles();
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
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, content, dirty: true } : t)));
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
          {(["catalog", "files", "history"] as Side[]).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)}>
              {s === "catalog" ? "Catalog" : s === "files" ? "Files" : "History"}
            </button>
          ))}
        </div>
        {side === "catalog" && <CatalogTree profile={profile} onInsert={(t) => editor.current?.insert(t)} />}
        {side === "files" && (
          <div className="side-body">
            <div className="side-tools">
              <span className="muted mono" title={dir}>
                {dir}
              </span>
              <button className="btn small" onClick={pickFile}>
                Open…
              </button>
            </div>
            {files.length === 0 ? (
              <div className="tree-note">No query files in this folder yet.</div>
            ) : (
              <ul className="side-list">
                {files.map((f) => (
                  <li key={f.path}>
                    <button onClick={() => openPath(f.path)} aria-current={f.path === active ? "true" : undefined}>
                      <span className="tree-name">{f.name}</span>
                      <span className="tree-hint">{relativeTime(f.modified)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
            <div key={t.path} className="qtab" role="tab" aria-selected={t.path === active} title={t.path}>
              {renaming?.path === t.path ? (
                <input
                  className="qtab-input"
                  autoFocus
                  aria-label="File name"
                  value={renaming.value}
                  onChange={(e) => setRenaming({ path: t.path, value: e.target.value })}
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
                  onDoubleClick={() => setRenaming({ path: t.path, value: t.name })}
                >
                  {t.name}
                  {t.dirty && (
                    <span className="unsaved" title="Saving…" aria-label="unsaved changes">
                      {" "}
                      ●
                    </span>
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
          <span className="toolbar-gap" />
          <label className="muted" htmlFor="wh-select">
            Warehouse
          </label>
          <select
            id="wh-select"
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
                <span>
                  <strong>{rowCount.toLocaleString()}</strong> {rowCount === 1 ? "row" : "rows"} ·{" "}
                  {seconds(result.durationMs)}
                </span>
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
                <div className="empty">The statement succeeded and returned no rows.</div>
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
