import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import {
  NotebookService,
  DesktopService,
  type Completion,
  type CellRun,
  type Cluster,
  type NotebookTab,
  type RemoteFile,
  type ServerlessEnvironment,
  type Workspace,
} from "../../bindings/dbx-desktop";
import type { File as NotebookFile } from "../../bindings/dbx-desktop/internal/queries/models";
import { ConfirmDialog } from "../dialogs";
import { displayName, errorText, relativeTime, shortHost, stateLabel } from "../lib";
import { classify, needsConfirm, type Risk } from "../sqlsplit";
import { PlaceBanner, ScratchPanel } from "../sql/ScratchFiles";
import { DeleteDialog } from "../sql/SqlView";
import { ConflictDialog, NOTEBOOKS, SaveToWorkspaceDialog, WorkspacePanel, WsIcon } from "../sql/WorkspaceFiles";
import { CellEditor, type CellEditorHandle } from "./CellEditor";
import { CellOutput, type CellRunState } from "./CellOutput";
import { languageOf, planCell } from "./command";
import { newCell, parseNotebook, serializeNotebook, type Cell } from "./format";
import { Markdown } from "./Markdown";

interface Tab {
  path: string;
  name: string;
  cells: Cell[];
  /** The source last written to or read from the file. */
  saved: string;
  /** True while the cells hold changes not yet written to the file. */
  dirty: boolean;
  remote?: RemoteFile;
}

function toTab(t: NotebookTab): Tab {
  return {
    path: t.file.path,
    name: t.file.name,
    cells: parseNotebook(t.content),
    saved: t.content,
    dirty: false,
    remote: t.remote ?? undefined,
  };
}

type Side = "scratch" | "workspace";

/** The compute choice for serverless, in place of a cluster ID. */
const SERVERLESS = "serverless";

/** Where cells run: a cluster, or serverless. */
interface Compute {
  id: string;
  name: string;
}

type Ask =
  | { kind: "start"; cluster: Cluster }
  | { kind: "prod-run"; path: string; ids: string[]; compute: Compute }
  | { kind: "sql-run"; path: string; ids: string[]; statement: string; risk: Risk }
  | { kind: "save"; path: string; name: string }
  | { kind: "conflict"; path: string; missing: boolean }
  | { kind: "revert"; path: string }
  | { kind: "delete"; paths: string[] }
  | null;

const SAVE_DELAY_MS = 700;
const CLUSTER_REFRESH_MS = 30_000;
const CLUSTER_REFRESH_BUSY_MS = 8_000;
const isMac = navigator.userAgent.includes("Mac");
const RUN_KEYS = isMac ? "⌘ Return" : "Ctrl+Enter";
const SAVE_KEYS = isMac ? "⌘S" : "Ctrl+S";

const ACCESS_MODES: Record<string, string> = {
  USER_ISOLATION: "Standard (shared)",
  DATA_SECURITY_MODE_STANDARD: "Standard (shared)",
  SINGLE_USER: "Dedicated",
  DATA_SECURITY_MODE_DEDICATED: "Dedicated",
  NONE: "No isolation shared",
  LEGACY_TABLE_ACL: "Table ACL (legacy)",
  LEGACY_PASSTHROUGH: "Passthrough (legacy)",
  LEGACY_SINGLE_USER: "Single user (legacy)",
  LEGACY_SINGLE_USER_STANDARD: "Single user (legacy)",
  DATA_SECURITY_MODE_AUTO: "Auto",
};

function accessLabel(mode: string): string {
  return ACCESS_MODES[mode] ?? (mode ? stateLabel(mode) : "Unknown access mode");
}

/** "15.4.x-scala2.12" → "DBR 15.4". */
function runtimeLabel(v: string): string {
  const m = /^(\d+\.\d+)/.exec(v);
  return m ? `DBR ${m[1]}${/-ml-/.test(v) ? " ML" : ""}` : v;
}

function suggestedName(fileName: string): string {
  const base = fileName.replace(/\.py$/i, "");
  return /^Untitled-\d+$/.test(base) ? "" : base;
}

/** A copy of a record without one key. */
function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

function textRun(text: string): CellRun {
  const r = failedRun("");
  r.output = { ...r.output, status: "finished", kind: text.trim() ? "text" : "none", text };
  return r;
}

function failedRun(msg: string): CellRun {
  return {
    output: {
      status: "failed",
      kind: "none",
      text: "",
      columns: [],
      rows: [],
      truncated: false,
      images: [],
      imageNotes: [],
      error: msg,
      detail: "",
      durationMs: 0,
    },
    started: false,
    lost: false,
    notRunning: "",
    needsSetup: false,
  };
}

export function NotebookView(props: { workspace: Workspace; visible: boolean; openRequest?: Completion | null }) {
  const ws = props.workspace;
  const profile = ws.profile.name;

  const [loaded, setLoaded] = useState(false);
  const [dir, setDir] = useState("");
  const [hasTrash, setHasTrash] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState("");
  /** Cell runs by cell id. */
  const [runs, setRuns] = useState<Record<string, CellRunState>>({});
  /** The cluster each notebook's live session runs on, by notebook path. */
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState("");
  const [clusterError, setClusterError] = useState("");
  const [serverlessVersion, setServerlessVersion] = useState(4);
  /** The local environment for serverless, loaded when serverless is chosen. */
  const [env, setEnv] = useState<ServerlessEnvironment | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [side, setSide] = useState<Side>("scratch");
  const [files, setFiles] = useState<NotebookFile[]>([]);
  const [ask, setAsk] = useState<Ask>(null);
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [pushing, setPushing] = useState<string[]>([]);
  const [wsKey, setWsKey] = useState(0);
  /** The cell that last had focus, by notebook path. */
  const [focused, setFocused] = useState<Record<string, string>>({});
  /** Markdown cells being edited rather than shown rendered. */
  const [editingMd, setEditingMd] = useState<Set<string>>(new Set());

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const editors = useRef(new Map<string, CellEditorHandle>());
  /** Notebooks confirmed to run on a production cluster: "path\ncluster". */
  const prodOk = useRef(new Set<string>());
  /** Bumped per notebook by Stop, which ends every run chain started before it. */
  const stops = useRef(new Map<string, number>());

  const activeTab = tabs.find((t) => t.path === active);
  const cluster = clusters.find((c) => c.id === clusterId);
  const serverless = clusterId === SERVERLESS;
  const compute: Compute | undefined = serverless ? { id: SERVERLESS, name: "Serverless" } : cluster;
  const sessionCluster = active ? sessions[active] : undefined;

  // ---------- Loading ----------

  const loadClusters = useCallback(async () => {
    try {
      const list = (await NotebookService.ListClusters(profile)) ?? [];
      setClusters(list);
      setClusterError("");
      return list;
    } catch (e) {
      setClusterError(errorText(e));
      return [];
    }
  }, [profile]);

  const loadFiles = useCallback(() => {
    NotebookService.ListNotebooks(profile)
      .then((f) => setFiles(f ?? []))
      .catch(() => {});
  }, [profile]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const st = await NotebookService.State(profile);
        if (!live) return;
        let open = (st.tabs ?? []).map(toTab);
        if (open.length === 0) {
          const t = await NotebookService.NewNotebook(profile);
          if (!live) return;
          open = [toTab(t)];
        }
        setDir(st.dir);
        setHasTrash(st.trash);
        setTabs(open);
        setSessions((st.sessions ?? {}) as Record<string, string>);
        setActive(open.some((t) => t.path === st.activeTab) ? st.activeTab : open[0].path);
        const list = await loadClusters();
        if (!live) return;
        setServerlessVersion(st.serverlessVersion || 4);
        const saved = st.clusterId === SERVERLESS ? SERVERLESS : list.find((c) => c.id === st.clusterId)?.id;
        setClusterId(saved ?? list[0]?.id ?? SERVERLESS);
      } catch (e) {
        if (live) setNotice(errorText(e));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [profile, loadClusters]);

  // Refresh cluster states, faster while one is starting.
  const busy = clusters.some((c) => ["PENDING", "RESTARTING", "TERMINATING", "RESIZING"].includes(c.state));
  useEffect(() => {
    if (!props.visible) return;
    const t = setInterval(loadClusters, busy ? CLUSTER_REFRESH_BUSY_MS : CLUSTER_REFRESH_MS);
    return () => clearInterval(t);
  }, [props.visible, busy, loadClusters]);

  const tabPaths = tabs.map((t) => t.path).join("\n");
  useEffect(() => {
    if (!loaded) return;
    NotebookService.SaveState(profile, clusterId, serverlessVersion, tabPaths ? tabPaths.split("\n") : [], active).catch(
      () => {},
    );
  }, [loaded, profile, clusterId, serverlessVersion, tabPaths, active]);

  const loadEnv = useCallback(() => {
    NotebookService.ServerlessStatus(serverlessVersion)
      .then(setEnv)
      .catch((e) => setNotice(errorText(e)));
  }, [serverlessVersion]);

  useEffect(() => {
    if (serverless) loadEnv();
  }, [serverless, loadEnv]);

  const setUpServerless = async () => {
    setSettingUp(true);
    setNotice("");
    try {
      setEnv(await NotebookService.SetUpServerless(serverlessVersion));
    } catch (e) {
      setNotice(`Could not set up serverless: ${errorText(e)}`);
      loadEnv();
    } finally {
      setSettingUp(false);
    }
  };

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
    const content = serializeNotebook(tab.cells);
    try {
      await NotebookService.WriteNotebook(path, content);
      setTabs((ts) =>
        ts.map((t) =>
          t.path === path && serializeNotebook(t.cells) === content ? { ...t, saved: content, dirty: false } : t,
        ),
      );
    } catch (e) {
      setNotice(`Could not save ${tab.name}: ${errorText(e)}`);
    }
  }, []);

  const scheduleSave = useCallback(
    (path: string) => {
      const old = timers.current.get(path);
      if (old) clearTimeout(old);
      timers.current.set(
        path,
        setTimeout(() => saveNow(path), SAVE_DELAY_MS),
      );
    },
    [saveNow],
  );

  /** Changes a notebook's cells and saves them shortly after. */
  const updateCells = useCallback(
    (path: string, fn: (cells: Cell[]) => Cell[]) => {
      setTabs((ts) =>
        ts.map((t) => {
          if (t.path !== path) return t;
          const cells = fn(t.cells);
          const changed = serializeNotebook(cells) !== t.saved;
          return {
            ...t,
            cells,
            dirty: changed || t.dirty,
            remote: t.remote && changed ? { ...t.remote, unsaved: true } : t.remote,
          };
        }),
      );
      scheduleSave(path);
    },
    [scheduleSave],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of tabsRef.current) {
        if (t.dirty) NotebookService.WriteNotebook(t.path, serializeNotebook(t.cells)).catch(() => {});
      }
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  // ---------- Tabs ----------

  const addTab = (t: Tab) => {
    setTabs((ts) => (ts.some((x) => x.path === t.path) ? ts : [...ts, t]));
    setActive(t.path);
  };

  const openPath = useCallback(
    async (path: string) => {
      if (tabsRef.current.some((t) => t.path === path)) {
        setActive(path);
        return;
      }
      try {
        addTab(toTab(await NotebookService.OpenNotebookWithLink(profile, path)));
      } catch (e) {
        setNotice(errorText(e));
      }
    },
    [profile],
  );

  useEffect(() => {
    if (loaded && props.openRequest) openPath(props.openRequest.path);
  }, [loaded, props.openRequest, openPath]);

  const newTab = async () => {
    try {
      addTab(toTab(await NotebookService.NewNotebook(profile)));
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  const pickFile = async () => {
    try {
      const path = await NotebookService.PickNotebook();
      if (path) await openPath(path);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  /** Stops a notebook's running and queued cells. */
  const stopNotebook = (path: string) => {
    stops.current.set(path, (stops.current.get(path) ?? 0) + 1);
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    const ids = new Set(tab.cells.map((c) => c.id));
    for (const [id, r] of Object.entries(runsRef.current)) {
      if (ids.has(id) && r.phase !== "done") NotebookService.CancelCell(r.runId).catch(() => {});
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
    // Closing a notebook ends its Python session, as detaching does in Databricks.
    stopNotebook(path);
    NotebookService.EndSession(profile, path).catch(() => {});
    setSessions((s) => without(s, path));
    const idx = list.findIndex((t) => t.path === path);
    const rest = list.filter((t) => t.path !== path);
    setTabs(rest);
    if (active === path) setActive((rest[idx] ?? rest[idx - 1])?.path ?? "");
  };

  const movePath = (oldPath: string, newPath: string) => {
    setSessions((s) => {
      if (!s[oldPath] || oldPath === newPath) return s;
      const { [oldPath]: moved, ...others } = s;
      return { ...others, [newPath]: moved };
    });
    setFocused((f) => {
      if (!f[oldPath]) return f;
      const { [oldPath]: moved, ...others } = f;
      return { ...others, [newPath]: moved };
    });
    const ok = [...prodOk.current].filter((k) => k.startsWith(oldPath + "\n"));
    ok.forEach((k) => prodOk.current.add(newPath + k.slice(oldPath.length)));
    setActive((a) => (a === oldPath ? newPath : a));
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { path, value } = renaming;
    setRenaming(null);
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || !value.trim() || value.trim() === tab.name) return;
    await saveNow(path);
    try {
      const f = await NotebookService.RenameNotebook(profile, path, value);
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, path: f.path, name: f.name } : t)));
      movePath(path, f.path);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  const deleteFiles = async (paths: string[]) => {
    for (const p of paths) {
      const timer = timers.current.get(p);
      if (timer) clearTimeout(timer);
      timers.current.delete(p);
      stopNotebook(p);
    }
    try {
      const res = await NotebookService.DeleteNotebooks(profile, paths);
      const gone = new Set(res.deleted ?? []);
      if (gone.size > 0) {
        const list = tabsRef.current;
        const rest = list.filter((t) => !gone.has(t.path));
        tabsRef.current = rest;
        setTabs(rest);
        setSessions((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !gone.has(k))));
        if (gone.has(active)) {
          const idx = list.findIndex((t) => t.path === active);
          const next =
            list.slice(idx + 1).find((t) => !gone.has(t.path)) ??
            [...list.slice(0, idx)].reverse().find((t) => !gone.has(t.path));
          setActive(next?.path ?? "");
        }
      }
      const errors = res.errors ?? [];
      setNotice(
        errors.length
          ? `Could not delete ${errors.length === 1 ? "a notebook" : `${errors.length} notebooks`}: ${errors.join("; ")}`
          : "",
      );
    } catch (e) {
      setNotice(errorText(e));
    }
    loadFiles();
  };

  // Files dropped on the window: open the .py ones here.
  useEffect(() => {
    if (!props.visible) return;
    const off = Events.On("files-dropped", (ev: { data: unknown }) => {
      const paths = Array.isArray(ev.data) ? (ev.data as string[]) : [];
      const py = paths.filter((p) => typeof p === "string" && p.toLowerCase().endsWith(".py"));
      if (py.length === 0) {
        if (paths.length) setNotice("Only .py notebooks can be opened here.");
        return;
      }
      py.forEach((p) => openPath(p));
    });
    return () => off();
  }, [props.visible, openPath]);

  // ---------- Workspace notebooks ----------

  const openRemote = async (remotePath: string) => {
    const open = tabsRef.current.find((t) => t.remote?.path === remotePath);
    if (open) {
      setActive(open.path);
      return;
    }
    try {
      const t = toTab(await NotebookService.OpenNotebookFromWorkspace(profile, remotePath));
      addTab(t);
      setNotice(t.remote?.unsaved ? `${t.name} has edits from earlier that are not saved to the workspace.` : "");
      setWsKey((n) => n + 1);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  const setRemote = (path: string, remote: RemoteFile) =>
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, remote } : t)));

  const saveToWorkspace = async (path: string, force = false) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || pushing.includes(path)) return;
    await saveNow(path);
    if (!tab.remote) {
      setAsk({ kind: "save", path, name: suggestedName(tab.name) });
      return;
    }
    const before = tabsRef.current.find((t) => t.path === path);
    const content = before ? serializeNotebook(before.cells) : "";
    setPushing((p) => [...p, path]);
    try {
      const res = await NotebookService.PushNotebook(profile, path, force);
      if (res.status === "saved" && res.remote) {
        const latest = tabsRef.current.find((t) => t.path === path);
        setRemote(path, { ...res.remote, unsaved: !!latest && serializeNotebook(latest.cells) !== content });
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

  const loadRemote = async (path: string) => {
    const timer = timers.current.get(path);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(path);
    }
    try {
      const t = toTab(await NotebookService.ReloadNotebookFromWorkspace(profile, path));
      // New cells get new ids, so their editors start fresh.
      setTabs((ts) => ts.map((x) => (x.path === path ? { ...t, path, name: x.name } : x)));
      setNotice("");
      setWsKey((n) => n + 1);
    } catch (e) {
      setNotice(errorText(e));
    }
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

  // ---------- Cells ----------

  /** A cell whose editor should take focus when it appears. */
  const pendingFocus = useRef<{ id: string; where: "start" | "end" } | null>(null);

  const focusCell = (id: string, where: "start" | "end" = "end") => {
    const ed = editors.current.get(id);
    if (ed) ed.focus(where);
    else pendingFocus.current = { id, where };
  };

  const addCell = (path: string, index: number, source = "") => {
    const cell = newCell(source);
    updateCells(path, (cells) => [...cells.slice(0, index), cell, ...cells.slice(index)]);
    if (languageOf(source) === "markdown") setEditingMd((s) => new Set(s).add(cell.id));
    focusCell(cell.id);
    return cell;
  };

  const deleteCell = (path: string, id: string) => {
    updateCells(path, (cells) => {
      const rest = cells.filter((c) => c.id !== id);
      return rest.length ? rest : [newCell()];
    });
  };

  const moveCell = (path: string, id: string, by: -1 | 1) => {
    updateCells(path, (cells) => {
      const i = cells.findIndex((c) => c.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= cells.length) return cells;
      const next = cells.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const setCellSource = useCallback(
    (path: string, id: string, source: string) =>
      updateCells(path, (cells) => cells.map((c) => (c.id === id ? { ...c, source } : c))),
    [updateCells],
  );

  // ---------- Running ----------

  const setRun = (id: string, r: CellRunState | undefined) =>
    setRuns((rs) => {
      return r ? { ...rs, [id]: r } : without(rs, id);
    });

  /** Runs cells one after another; an error or cancel stops the rest. */
  const execute = async (path: string, ids: string[]) => {
    const target = compute;
    if (!target) return;
    const epoch = stops.current.get(path) ?? 0;
    await saveNow(path);

    // Show which cells are waiting.
    const runIds = new Map(ids.map((id) => [id, crypto.randomUUID()]));
    setRuns((rs) => {
      const next = { ...rs };
      for (const id of ids) {
        next[id] = { runId: runIds.get(id)!, phase: "queued", startedAt: Date.now(), clusterName: target.name };
      }
      return next;
    });

    let stopped = false;
    let attempted = false;
    let completionStatus = "finished";
    for (const id of ids) {
      const runId = runIds.get(id)!;
      if (stopped || (stops.current.get(path) ?? 0) !== epoch) {
        setRuns((rs) => (rs[id]?.runId === runId ? without(rs, id) : rs));
        continue;
      }
      const cell = tabsRef.current.find((t) => t.path === path)?.cells.find((c) => c.id === id);
      const plan = cell ? planCell(cell.source) : { kind: "empty" as const };
      if (plan.kind === "markdown" || plan.kind === "empty") {
        setRun(id, undefined);
        if (plan.kind === "markdown") setEditingMd((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : s));
        continue;
      }
      if (plan.kind === "pip") {
        attempted = true;
        let result: CellRun;
        if (target.id !== SERVERLESS) {
          result = failedRun(
            "%pip runs only with serverless compute here, where it installs into this computer's Python environment. On a cluster, install the library on the cluster instead.",
          );
        } else {
          setRun(id, { runId, phase: "running", startedAt: Date.now(), clusterName: "this computer" });
          try {
            result = textRun(await NotebookService.PipInstall(serverlessVersion, plan.args));
          } catch (e) {
            result = failedRun(errorText(e));
          }
        }
        setRuns((rs) =>
          rs[id]?.runId === runId ? { ...rs, [id]: { ...rs[id], phase: "done", clusterName: "", result } } : rs,
        );
        if (result.output.status !== "finished") { stopped = true; completionStatus = result.output.status; }
        continue;
      }
      if (plan.kind === "unsupported") {
        attempted = true;
        completionStatus = "failed";
        setRun(id, { runId, phase: "done", startedAt: Date.now(), clusterName: "", result: failedRun(`${plan.magic}: ${plan.reason}`) });
        stopped = true;
        continue;
      }
      setRun(id, { runId, phase: "running", startedAt: Date.now(), clusterName: target.name });
      attempted = true;
      let result: CellRun;
      try {
        result = await NotebookService.RunCell(profile, target.id, serverlessVersion, path, plan.code, runId);
      } catch (e) {
        result = failedRun(errorText(e));
      }
      // The notebook may have been renamed or saved elsewhere while it ran.
      const now = tabsRef.current.find((t) => t.cells.some((c) => c.id === id))?.path ?? path;
      const status = result.output.status;
      if (status !== "failed") setSessions((s) => ({ ...s, [now]: target.id }));
      if (result.notRunning) loadClusters();
      if (result.needsSetup) loadEnv();
      if (result.lost) {
        setNotice(
          target.id === SERVERLESS
            ? "The local Python session had stopped. A new session started; variables from earlier cells are gone."
            : `The Python session on ${target.name} had ended, probably because the cluster restarted. A new session started; variables from earlier cells are gone.`,
        );
      }
      setRuns((rs) => (rs[id]?.runId === runId ? { ...rs, [id]: { ...rs[id], phase: "done", result } } : rs));
      if (status !== "finished") { stopped = true; completionStatus = status; }
    }
    const tab = tabsRef.current.find((t) => t.cells.some((c) => ids.includes(c.id)));
    if (attempted && tab && (stops.current.get(path) ?? 0) === epoch) {
      DesktopService.NotifyCompletion({
        id: runIds.get(ids[0])!, kind: "notebooks", profile, path: tab.path, name: tab.name, status: completionStatus,
      }).catch(() => {});
    }
  };

  /** Checks a run against production and destructive-SQL rules, then runs it. */
  const requestRun = (path: string, ids: string[]) => {
    if (!compute) {
      setNotice("Choose a cluster or serverless first.");
      return;
    }
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    if (ids.some((id) => runsRef.current[id] && runsRef.current[id].phase !== "done")) return;
    setNotice("");
    if (ws.meta.prod && sessionsRef.current[path] !== compute.id && !prodOk.current.has(`${path}\n${compute.id}`)) {
      setAsk({ kind: "prod-run", path, ids, compute });
      return;
    }
    checkSql(path, ids);
  };

  const checkSql = (path: string, ids: string[]) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    let worst: { statement: string; risk: Risk } | null = null;
    for (const id of ids) {
      const cell = tab.cells.find((c) => c.id === id);
      const plan = cell ? planCell(cell.source) : null;
      if (plan?.kind !== "sql") continue;
      for (const s of plan.statements) {
        const risk = classify(s);
        if (needsConfirm(risk, ws.meta.prod) && (!worst || risk === "destructive")) worst = { statement: s, risk };
      }
    }
    if (worst) setAsk({ kind: "sql-run", path, ids, ...worst });
    else execute(path, ids);
  };

  const runCell = (path: string, id: string) => requestRun(path, [id]);

  const runAdvance = (path: string, id: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    const i = tab.cells.findIndex((c) => c.id === id);
    runCell(path, id);
    moveOn(path, i);
  };

  /**
   * Moves the cursor to the first cell after index i that has an editor,
   * skipping rendered Markdown, or adds a cell at the end.
   */
  const moveOn = (path: string, i: number) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    const next = tab.cells.slice(i + 1).find((c) => languageOf(c.source) !== "markdown" || editingMd.has(c.id));
    if (next) focusCell(next.id, "start");
    else addCell(path, tab.cells.length);
  };

  const runAll = (path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (tab) requestRun(path, tab.cells.map((c) => c.id));
  };

  const runFrom = (path: string, id: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    const i = tab.cells.findIndex((c) => c.id === id);
    requestRun(path, tab.cells.slice(i).map((c) => c.id));
  };

  const resetSession = async (path: string) => {
    stopNotebook(path);
    try {
      await NotebookService.EndSession(profile, path);
      setSessions((s) => without(s, path));
      setNotice("The Python session ended. The next cell you run starts a new one.");
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  const clearOutputs = (path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    const ids = new Set(tab.cells.map((c) => c.id));
    setRuns((rs) => Object.fromEntries(Object.entries(rs).filter(([k, r]) => !ids.has(k) || r.phase !== "done")));
  };

  const startCluster = async (c: Cluster) => {
    try {
      await NotebookService.StartCluster(profile, c.id);
      setNotice(`${c.name} is starting. That usually takes a few minutes.`);
    } catch (e) {
      setNotice(errorText(e));
    }
    await loadClusters();
  };

  const anyRunning = !!activeTab && activeTab.cells.some((c) => runs[c.id] && runs[c.id].phase !== "done");
  const canStart = cluster && (cluster.state === "TERMINATED" || cluster.state === "ERROR");
  const clusterReady = cluster && (cluster.state === "RUNNING" || cluster.state === "RESIZING");
  const sessionName =
    sessionCluster === SERVERLESS
      ? "serverless"
      : sessionCluster
        ? (clusters.find((c) => c.id === sessionCluster)?.name ?? "another cluster")
        : "";

  return (
    <div className="sql notebook" data-file-drop-target>
      <aside className="side" aria-label="Notebooks">
        <div className="side-tabs" role="tablist">
          <button role="tab" aria-selected={side === "scratch"} onClick={() => setSide("scratch")}>
            Scratch
          </button>
          <button role="tab" aria-selected={side === "workspace"} onClick={() => setSide("workspace")}>
            Workspace
          </button>
        </div>
        {side === "workspace" && (
          <>
            <PlaceBanner kind="workspace" title="Workspace" detail={shortHost(ws.profile.host)}>
              Python notebooks stored in Databricks. Edits stay on this computer until you save with {SAVE_KEYS}.
            </PlaceBanner>
            <WorkspacePanel
              kind={NOTEBOOKS}
              profile={profile}
              reloadKey={wsKey}
              current={activeTab?.remote?.path}
              onOpen={openRemote}
            />
          </>
        )}
        {side === "scratch" && (
          <>
            <PlaceBanner kind="scratch" title="Scratch" detail={dir} detailTitle={dir}>
              Local notebooks on this computer, saved as you type. Not in Databricks until you save one to the
              workspace.
            </PlaceBanner>
            <div className="side-body">
              <ScratchPanel
                files={files}
                current={activeTab && !activeTab.remote ? activeTab.path : undefined}
                onOpen={openPath}
                onDelete={(paths) => paths.length && setAsk({ kind: "delete", paths })}
                empty="No scratch notebooks yet. Use ＋ above the cells to start one."
              />
              <div className="scratch-foot">
                <button className="link" onClick={pickFile}>
                  Open a .py notebook from elsewhere…
                </button>
              </div>
            </div>
          </>
        )}
      </aside>

      <section className="work">
        <div className="tabstrip" role="tablist" aria-label="Open notebooks">
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
                  aria-label="Notebook name"
                  value={renaming.value}
                  onChange={(e) => setRenaming({ path: t.path, value: e.target.value })}
                  onFocus={(e) => {
                    const dot = e.target.value.toLowerCase().lastIndexOf(".py");
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
                  <span className="qtab-label">{t.remote ? t.name.replace(/\.py$/i, "") : t.name}</span>
                  {sessions[t.path] && (
                    <span className="session-dot" title="Has a live Python session" aria-label="live session" />
                  )}
                  {t.remote?.unsaved ? (
                    <span className="unsaved remote" title={`Not saved to the workspace. ${SAVE_KEYS} saves it.`}>
                      {" "}
                      ●
                    </span>
                  ) : (
                    t.dirty && (
                      <span className="unsaved" title="Saving…">
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
          <button className="qtab-add" onClick={newTab} aria-label="New notebook" title="New notebook">
            ＋
          </button>
        </div>

        <div className="toolbar">
          <button
            className="btn primary"
            onClick={() => activeTab && runAll(activeTab.path)}
            disabled={!activeTab || anyRunning || !compute}
          >
            Run all
          </button>
          {anyRunning && (
            <button className="btn" onClick={() => activeTab && stopNotebook(activeTab.path)}>
              Stop
            </button>
          )}
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
              title="Keep this notebook in the Databricks workspace"
            >
              Save to workspace… <span className="keys">{SAVE_KEYS}</span>
            </button>
          )}
          <span className="toolbar-gap" />
          <label className="muted" htmlFor="cluster-select">
            Compute
          </label>
          <select
            id="cluster-select"
            aria-label="Compute"
            className="input select"
            value={clusterId}
            onChange={(e) => setClusterId(e.target.value)}
          >
            <option value={SERVERLESS}>Serverless</option>
            <optgroup label={clusters.length ? "All-purpose clusters" : clusterError ? "Clusters unavailable" : "No all-purpose clusters"}>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </select>
          {cluster && (
            <span className={clusterReady ? "badge ok" : "badge"} title={cluster.stateMessage || undefined}>
              {stateLabel(cluster.state)}
            </span>
          )}
          {canStart && (
            <button
              className="btn small"
              onClick={() => (ws.meta.prod ? setAsk({ kind: "start", cluster }) : startCluster(cluster))}
            >
              Start
            </button>
          )}
        </div>

        {activeTab && (
          <div className="nb-session">
            {serverless ? (
              <ServerlessInfo
                env={env}
                version={serverlessVersion}
                busy={settingUp}
                onVersion={setServerlessVersion}
                onSetUp={setUpServerless}
                onRecheck={loadEnv}
              />
            ) : cluster ? (
              <span className="muted" title={cluster.id}>
                {runtimeLabel(cluster.runtime)} · {accessLabel(cluster.accessMode)}
                {cluster.singleUser ? ` (${cluster.singleUser})` : ""} · {cluster.workers}
                {cluster.autoStopMinutes > 0 ? ` · stops after ${cluster.autoStopMinutes} min idle` : ""}
              </span>
            ) : (
              <span className="muted">
                {clusterError || "No all-purpose cluster found. Create one in Databricks to run notebooks here."}
              </span>
            )}
            <span className="toolbar-gap" />
            {sessionCluster ? (
              <>
                <span>
                  {sessionCluster === clusterId ? (
                    <>
                      <span className="session-dot" aria-hidden="true" /> Python session on {sessionName}
                    </>
                  ) : (
                    <>Session on {sessionName}. Running a cell here starts a new one on the chosen compute.</>
                  )}
                </span>
                <button className="btn small" onClick={() => resetSession(activeTab.path)} title="End the session and clear its variables">
                  End session
                </button>
              </>
            ) : (
              <span className="muted">No session yet. The first cell you run starts one.</span>
            )}
            <button className="btn small" onClick={() => clearOutputs(activeTab.path)}>
              Clear outputs
            </button>
          </div>
        )}

        {(notice || (clusterError && clusters.length > 0)) && (
          <div className="sql-notice" role="status">
            <span>{notice || clusterError}</span>
            {notice && (
              <button className="link" onClick={() => setNotice("")}>
                Dismiss
              </button>
            )}
          </div>
        )}

        <div className="nb-cells">
          {activeTab ? (
            <>
              {activeTab.cells.map((cell, i) => {
                const lang = languageOf(cell.source);
                const plan = lang === "markdown" ? planCell(cell.source) : null;
                const showMd = lang === "markdown" && !editingMd.has(cell.id) && plan?.kind === "markdown";
                const run = runs[cell.id];
                const isFocused = focused[activeTab.path] === cell.id;
                const path = activeTab.path;
                return (
                  <div key={cell.id}>
                    <div className={`nb-cell${isFocused ? " focused" : ""}`} data-lang={lang}>
                      <div className="nb-cell-bar">
                        <span className="nb-cell-lang">
                          {lang === "python" ? "Python" : lang === "sql" ? "SQL" : lang === "markdown" ? "Markdown" : "Other"}
                        </span>
                        {cell.title && <span className="nb-cell-title">{cell.title}</span>}
                        <span className="toolbar-gap" />
                        {lang !== "markdown" && (
                          <>
                            <button
                              className="icon-btn"
                              title={`Run cell (${RUN_KEYS})`}
                              aria-label="Run cell"
                              disabled={!!run && run.phase !== "done"}
                              onClick={() => runCell(path, cell.id)}
                            >
                              ▶
                            </button>
                            <button
                              className="icon-btn"
                              title="Run this cell and all below"
                              aria-label="Run this cell and all below"
                              disabled={anyRunning}
                              onClick={() => runFrom(path, cell.id)}
                            >
                              ↧
                            </button>
                          </>
                        )}
                        {lang === "markdown" && (
                          <button
                            className="icon-btn"
                            title={showMd ? "Edit" : "Show rendered"}
                            aria-label={showMd ? "Edit Markdown" : "Show rendered Markdown"}
                            onClick={() =>
                              setEditingMd((s) => {
                                const n = new Set(s);
                                if (showMd) n.add(cell.id);
                                else n.delete(cell.id);
                                return n;
                              })
                            }
                          >
                            {showMd ? "✎" : "✓"}
                          </button>
                        )}
                        <button
                          className="icon-btn"
                          title="Move up"
                          aria-label="Move cell up"
                          disabled={i === 0}
                          onClick={() => moveCell(path, cell.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="icon-btn"
                          title="Move down"
                          aria-label="Move cell down"
                          disabled={i === activeTab.cells.length - 1}
                          onClick={() => moveCell(path, cell.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className="icon-btn"
                          title="Delete cell"
                          aria-label="Delete cell"
                          onClick={() => deleteCell(path, cell.id)}
                        >
                          ×
                        </button>
                      </div>
                      {showMd && plan?.kind === "markdown" ? (
                        <div
                          className="nb-md"
                          onDoubleClick={() => {
                            setEditingMd((s) => new Set(s).add(cell.id));
                            focusCell(cell.id, "end");
                          }}
                          title="Double-click to edit"
                        >
                          {plan.text.trim() ? <Markdown text={plan.text} /> : <span className="muted">Empty Markdown cell</span>}
                        </div>
                      ) : (
                        <CellEditor
                          ref={(h) => {
                            if (h) {
                              editors.current.set(cell.id, h);
                              if (pendingFocus.current?.id === cell.id) pendingFocus.current = null;
                            } else {
                              editors.current.delete(cell.id);
                            }
                          }}
                          initial={cell.source}
                          autoFocus={pendingFocus.current?.id === cell.id ? pendingFocus.current.where : undefined}
                          onChange={(text) => setCellSource(path, cell.id, text)}
                          onRun={() =>
                            lang === "markdown"
                              ? setEditingMd((s) => new Set([...s].filter((x) => x !== cell.id)))
                              : runCell(path, cell.id)
                          }
                          onRunAdvance={() => {
                            if (lang === "markdown") {
                              setEditingMd((s) => new Set([...s].filter((x) => x !== cell.id)));
                              moveOn(path, i);
                            } else {
                              runAdvance(path, cell.id);
                            }
                          }}
                          onLeave={(dir) => {
                            const j = dir === "up" ? i - 1 : i + 1;
                            const other = activeTab.cells[j];
                            if (other) focusCell(other.id, dir === "up" ? "end" : "start");
                          }}
                          onFocus={() => setFocused((f) => ({ ...f, [path]: cell.id }))}
                        />
                      )}
                      {run && (
                        <CellOutput
                          run={run}
                          onCancel={() => {
                            if (run.phase === "queued") stopNotebook(path);
                            else NotebookService.CancelCell(run.runId).catch(() => {});
                          }}
                        />
                      )}
                    </div>
                    <div className="nb-add">
                      <button className="link" onClick={() => addCell(path, i + 1)}>
                        ＋ Python
                      </button>
                      <button className="link" onClick={() => addCell(path, i + 1, "%sql\n")}>
                        ＋ SQL
                      </button>
                      <button className="link" onClick={() => addCell(path, i + 1, "%md\n")}>
                        ＋ Markdown
                      </button>
                    </div>
                  </div>
                );
              })}
              <p className="nb-hint muted">
                {RUN_KEYS} runs a cell; Shift+Return runs it and moves to the next. SQL cells run with spark.sql in the
                same session, so they see temporary views made in Python.
              </p>
            </>
          ) : (
            <div className="empty">
              {loaded ? (
                <>
                  No notebook is open.{" "}
                  <button className="link" onClick={newTab}>
                    New notebook
                  </button>
                </>
              ) : (
                "Loading…"
              )}
            </div>
          )}
        </div>
      </section>

      {ask?.kind === "prod-run" && (
        <ConfirmDialog
          title="Run Python on production?"
          confirmLabel="Run"
          danger
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const { path, ids, compute: c } = ask;
            setAsk(null);
            prodOk.current.add(`${path}\n${c.id}`);
            checkSql(path, ids);
          }}
        >
          <p>
            This starts a Python session on <strong>{ask.compute.name}</strong> in <strong>{displayName(ws)}</strong>, a
            production workspace. Python cells can read and change any data you have access to. You are asked once
            per notebook and compute.
          </p>
        </ConfirmDialog>
      )}
      {ask?.kind === "sql-run" && (
        <ConfirmDialog
          title={ask.risk === "destructive" ? "Run this destructive statement?" : "Run this statement on production?"}
          confirmLabel="Run"
          danger
          requireText={ws.meta.prod && ask.risk === "destructive" ? ws.profile.name : undefined}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const { path, ids } = ask;
            setAsk(null);
            execute(path, ids);
          }}
        >
          <p>
            {ask.risk === "destructive"
              ? "A SQL cell removes or replaces data or objects"
              : "A SQL cell changes data or objects"}{" "}
            in <strong>{displayName(ws)}</strong>
            {ws.meta.prod ? ", a production workspace." : "."}
          </p>
          <pre className="confirm-sql">{ask.statement}</pre>
        </ConfirmDialog>
      )}
      {ask?.kind === "start" && (
        <ConfirmDialog
          title={`Start ${ask.cluster.name}?`}
          confirmLabel="Start cluster"
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const c = ask.cluster;
            setAsk(null);
            startCluster(c);
          }}
        >
          <p>
            A running cluster is billed until it stops. This starts it in <strong>{displayName(ws)}</strong>, a
            production workspace.
          </p>
        </ConfirmDialog>
      )}
      {ask?.kind === "save" && (
        <SaveToWorkspaceDialog
          kind={NOTEBOOKS}
          profile={profile}
          defaultName={ask.name}
          note="The scratch copy is removed once it is saved. Cell outputs are not saved."
          onClose={() => setAsk(null)}
          onSave={async (folder, name) => {
            const oldPath = ask.path;
            await saveNow(oldPath);
            const t = await NotebookService.SaveNotebookToWorkspace(profile, oldPath, folder, name);
            setAsk(null);
            // Keep the cells (and so their outputs) and point the tab at the new copy.
            setTabs((ts) =>
              ts
                .filter((x) => x.path !== t.file.path || x.path === oldPath)
                .map((x) =>
                  x.path === oldPath
                    ? { ...x, path: t.file.path, name: t.file.name, saved: t.content, dirty: false, remote: t.remote ?? undefined }
                    : x,
                ),
            );
            movePath(oldPath, t.file.path);
            setNotice("");
            setWsKey((n) => n + 1);
            if (side === "scratch") loadFiles();
          }}
        />
      )}
      {ask?.kind === "conflict" && (
        <ConflictDialog
          name={tabs.find((t) => t.path === ask.path)?.name.replace(/\.py$/i, "") ?? ""}
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
            This replaces the notebook with the version saved in the workspace,{" "}
            <span className="mono">{tabs.find((t) => t.path === ask.path)?.remote?.path}</span>. It cannot be undone.
          </p>
        </ConfirmDialog>
      )}
      {ask?.kind === "delete" && (
        <DeleteDialog
          paths={ask.paths}
          names={ask.paths.map((p) => files.find((f) => f.path === p)?.name ?? p.split(/[\\/]/).pop() ?? p)}
          open={tabs.filter((t) => ask.paths.includes(t.path)).length}
          trash={hasTrash}
          plural="scratch notebooks"
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const paths = ask.paths;
            setAsk(null);
            deleteFiles(paths);
          }}
        />
      )}
    </div>
  );
}

/** The session bar's description of serverless and its local environment. */
function ServerlessInfo(props: {
  env: ServerlessEnvironment | null;
  version: number;
  busy: boolean;
  onVersion: (v: number) => void;
  onSetUp: () => void;
  onRecheck: () => void;
}) {
  const { env } = props;
  const versions = env?.versions ?? [3, 4, 5, 2];
  return (
    <span className="serverless-info">
      <select
        className="input select small"
        aria-label="Serverless environment version"
        title="Serverless environment version"
        value={props.version}
        disabled={props.busy}
        onChange={(e) => props.onVersion(Number(e.target.value))}
      >
        {versions.map((v) => (
          <option key={v} value={v}>
            Environment {v}
          </option>
        ))}
      </select>
      {!env ? (
        <span className="muted">Checking…</span>
      ) : env.ready ? (
        <span className="muted" title={env.dir}>
          Databricks Connect {env.connect} · Python {env.python}. Spark and SQL run on serverless; other Python runs on
          this computer.
        </span>
      ) : props.busy ? (
        <span>
          <span className="spinner" aria-hidden="true" /> Setting up Python and Databricks Connect. This downloads a few
          hundred MB and can take a few minutes…
        </span>
      ) : env.uv ? (
        <>
          <span className="muted">
            Serverless notebooks run Python on this computer with Databricks Connect, which needs a local environment.
          </span>
          <button className="btn small primary" onClick={props.onSetUp}>
            Set up
          </button>
        </>
      ) : (
        <>
          <span className="muted">
            Serverless needs uv to set up Python. Install it, then check again:{" "}
            {(env.installUv ?? []).map((c, i) => (
              <code key={i} className="mono serverless-cmd">
                {c}
              </code>
            ))}
          </span>
          <button className="btn small" onClick={props.onRecheck}>
            Check again
          </button>
        </>
      )}
    </span>
  );
}
