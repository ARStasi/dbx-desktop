import { useCallback, useEffect, useState } from "react";
import { Events } from "@wailsio/runtime";
import { WorkspaceService, type AppStatus, type Workspace, type Completion } from "../bindings/dbx-desktop";
import { DesktopSettings } from "./DesktopSettings";
import { AddWorkspaceDialog, EditWorkspaceDialog, RemoveWorkspaceDialog, SigningInDialog } from "./dialogs";
import { Overview } from "./Overview";
import { Profiles } from "./Profiles";
import { NotebookView } from "./notebook/NotebookView";
import { SqlView } from "./sql/SqlView";
import { displayName, errorText, shortHost } from "./lib";
import { CloudStatus, CloudStatusIndicator } from "./status/CloudStatus";
import { useCloudStatus } from "./status/useCloudStatus";

type View = "overview" | "sql" | "notebooks" | "profiles" | "status" | "settings";

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; ws: Workspace }
  | { kind: "remove"; ws: Workspace }
  | { kind: "signing-in"; ws: Workspace }
  | null;

export default function App() {
  const cloudStatus = useCloudStatus();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState("");
  // Bumped after a sign-in so the overview reloads with the new credentials.
  const [authEpoch, setAuthEpoch] = useState<Record<string, number>>({});
  // The SQL view stays mounted once opened so results survive switching views.
  const [sqlOpened, setSqlOpened] = useState<string[]>([]);
  const [notebooksOpened, setNotebooksOpened] = useState<string[]>([]);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const openSQL = (profile: string) => setSqlOpened((xs) => xs.includes(profile) ? xs : [...xs, profile]);
  const openNotebooks = (profile: string) => setNotebooksOpened((xs) => xs.includes(profile) ? xs : [...xs, profile]);

  const reload = useCallback(async () => {
    try {
      setWorkspaces((await WorkspaceService.ListWorkspaces()) ?? []);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    WorkspaceService.Status(false).then(setStatus).catch((e) => setError(errorText(e)));
    reload();
  }, [reload]);

  useEffect(() => {
    const offSettings = Events.On("desktop-settings", () => setView("settings"));
    const offCompletion = Events.On("completion-open", async (event) => {
      const c = event.data;
      if (c.kind !== "sql" && c.kind !== "notebooks") return;
      try {
        await WorkspaceService.SetActive(c.profile);
        await reload();
        if (c.kind === "sql") openSQL(c.profile); else openNotebooks(c.profile);
        setCompletion(c);
        setView(c.kind);
      } catch (e) { setError(errorText(e)); }
    });
    return () => { offSettings(); offCompletion(); };
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
    await reload();
  };

  const activate = (ws: Workspace) =>
    run(async () => {
      await WorkspaceService.SetActive(ws.profile.name);
      setView((v) => (v === "profiles" || v === "status" || v === "settings" ? "overview" : v));
      // Keep the same view when changing workspaces, without discarding results.
      if (view === "sql") openSQL(ws.profile.name);
      if (view === "notebooks") openNotebooks(ws.profile.name);
    });

  const signIn = async (ws: Workspace, fn: (profile: string) => Promise<void>) => {
    setDialog({ kind: "signing-in", ws });
    await run(() => fn(ws.profile.name));
    setDialog(null);
    setAuthEpoch((epochs) => ({ ...epochs, [ws.profile.name]: (epochs[ws.profile.name] ?? 0) + 1 }));
  };

  const cli = status?.cli;
  const cliReady = !!cli?.found && !cli.legacy;
  const palette = status?.palette ?? [];
  const selectable = workspaces.filter((w) => !w.profile.isAccount);
  const active = workspaces.find((w) => w.active);
  const closeAndReload = () => {
    setDialog(null);
    reload();
  };

  return (
    <div className="app" style={{ ["--ws" as string]: active?.meta.color ?? "var(--border)" }}>
      <nav className="rail" aria-label="Workspaces">
        <div className="rail-title">Workspaces</div>
        <div className="rail-list">
          {selectable.map((ws) => (
            <button
              key={ws.profile.name}
              className="rail-item"
              aria-current={ws.active && view !== "profiles" && view !== "status" && view !== "settings" ? "true" : undefined}
              title={shortHost(ws.profile.host)}
              onClick={() => activate(ws)}
            >
              <span className="dot" style={{ ["--dot" as string]: ws.meta.color }} aria-hidden="true" />
              <span className="name">{displayName(ws)}</span>
              {ws.meta.prod && <span className="badge prod">Prod</span>}
            </button>
          ))}
          <button className="rail-item subtle" onClick={() => setDialog({ kind: "add" })}>
            <span aria-hidden="true">＋</span>
            <span className="name">Add workspace</span>
          </button>
        </div>
        <div className="rail-spacer" />
        <CloudStatusIndicator state={cloudStatus} active={view === "status"} onOpen={() => setView("status")} />
        <button
          className="rail-item"
          aria-current={view === "profiles" ? "true" : undefined}
          onClick={() => setView("profiles")}
        >
          <span className="name">Manage profiles</span>
        </button>
        <button className="rail-item" aria-current={view === "settings" ? "true" : undefined} onClick={() => setView("settings")}>
          <span className="name">Settings</span>
        </button>
        <div className="rail-foot">
          {cli ? (cli.found ? `Databricks CLI ${cli.version || ""}` : "Databricks CLI not found") : " "}
        </div>
      </nav>

      <div className="main">
        <header className="identity">
          {active ? (
            <>
              <span className="dot" aria-hidden="true" />
              <div className="who">
                <strong>{displayName(active)}</strong>
                <span className="muted mono">{shortHost(active.profile.host)}</span>
              </div>
              {active.meta.prod && <span className="badge prod">Production</span>}
              <div className="views" role="tablist" aria-label="Views">
                <button role="tab" aria-selected={view === "overview"} onClick={() => setView("overview")}>
                  Overview
                </button>
                <button
                  role="tab"
                  aria-selected={view === "sql"}
                  onClick={() => {
                    openSQL(active.profile.name);
                    setView("sql");
                  }}
                >
                  SQL
                </button>
                <button
                  role="tab"
                  aria-selected={view === "notebooks"}
                  onClick={() => {
                    openNotebooks(active.profile.name);
                    setView("notebooks");
                  }}
                >
                  Notebooks
                </button>
              </div>
            </>
          ) : (
            <div className="who">
              <strong>dbx-desktop</strong>
            </div>
          )}
        </header>

        {workspaces.filter((ws) => sqlOpened.includes(ws.profile.name)).map((ws) => (
          <div key={`${ws.profile.name}:${authEpoch[ws.profile.name] ?? 0}`} className="content flush" hidden={view !== "sql" || !ws.active}>
            <SqlView workspace={ws} visible={view === "sql" && ws.active}
              openRequest={completion?.kind === "sql" && completion.profile === ws.profile.name ? completion : null} />
          </div>
        ))}

        {workspaces.filter((ws) => notebooksOpened.includes(ws.profile.name)).map((ws) => (
          <div key={`${ws.profile.name}:${authEpoch[ws.profile.name] ?? 0}`} className="content flush" hidden={view !== "notebooks" || !ws.active}>
            <NotebookView
              workspace={ws}
              visible={view === "notebooks" && ws.active}
              openRequest={completion?.kind === "notebooks" && completion.profile === ws.profile.name ? completion : null}
            />
          </div>
        ))}

        <main className="content" hidden={(view === "sql" || view === "notebooks") && !!active}>
          {cli && !cliReady && (
            <div className="page" style={{ marginBottom: 18 }}>
              <div className="notice" role="status">
                <div>
                  <strong>
                    {cli.found
                      ? `Databricks CLI ${cli.version} is too old for browser sign-in`
                      : "The Databricks CLI is not installed"}
                  </strong>
                  <div>Browser sign-in needs the current CLI. Install it with:</div>
                  {(cli.installHelp ?? []).map((s) => (
                    <div key={s.label}>
                      <code className="mono">{s.command}</code>
                    </div>
                  ))}
                </div>
                <button
                  className="btn"
                  onClick={() => WorkspaceService.Status(true).then(setStatus).catch((e) => setError(errorText(e)))}
                >
                  Check again
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="page" style={{ marginBottom: 18 }}>
              <div className="notice error" role="alert">
                <span>{error}</span>
                <button className="btn small" onClick={() => setError("")}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {view === "settings" ? <DesktopSettings /> : view === "status" ? <CloudStatus state={cloudStatus} /> : view === "profiles" ? (
            <Profiles
              workspaces={workspaces}
              configPath={status?.configPath ?? ""}
              cliReady={cliReady}
              onAdd={() => setDialog({ kind: "add" })}
              onEdit={(ws) => setDialog({ kind: "edit", ws })}
              onRemove={(ws) => setDialog({ kind: "remove", ws })}
              onSignIn={(ws) => signIn(ws, WorkspaceService.Reauthenticate)}
              onSwitchToOAuth={(ws) => signIn(ws, WorkspaceService.SwitchToOAuth)}
              onSetDefault={(ws) => run(() => WorkspaceService.SetDefaultProfile(ws.profile.name))}
            />
          ) : active && view === "overview" ? (
            <Overview
              key={active.profile.name}
              workspace={active}
              authEpoch={authEpoch[active.profile.name] ?? 0}
              onSignIn={(ws) => signIn(ws, WorkspaceService.Reauthenticate)}
            />
          ) : loaded && !active ? (
            <div className="welcome">
              <h1>Add your first workspace</h1>
              <p className="muted">
                Sign in to a Databricks workspace to get started. It is saved as a profile in your Databricks config
                file, so the CLI can use it too.
              </p>
              <button className="btn primary" onClick={() => setDialog({ kind: "add" })}>
                Add workspace
              </button>
            </div>
          ) : null}
        </main>
      </div>

      {dialog?.kind === "add" && (
        <AddWorkspaceDialog
          cliReady={cliReady}
          onClose={() => setDialog(null)}
          onAdded={() => {
            setView("overview");
            closeAndReload();
          }}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditWorkspaceDialog
          workspace={dialog.ws}
          palette={palette}
          onClose={() => setDialog(null)}
          onSaved={closeAndReload}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemoveWorkspaceDialog
          workspace={dialog.ws}
          configPath={status?.configPath ?? ""}
          onClose={() => setDialog(null)}
          onRemoved={closeAndReload}
        />
      )}
      {dialog?.kind === "signing-in" && <SigningInDialog host={dialog.ws.profile.host} />}
    </div>
  );
}
