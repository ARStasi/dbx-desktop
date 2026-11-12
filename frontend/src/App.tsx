import { useCallback, useEffect, useState } from "react";
import { WorkspaceService, type AppStatus, type Workspace } from "../bindings/dbx-desktop";
import { AddWorkspaceDialog, EditWorkspaceDialog, RemoveWorkspaceDialog, SigningInDialog } from "./dialogs";
import { Overview } from "./Overview";
import { Profiles } from "./Profiles";
import { SqlView } from "./sql/SqlView";
import { displayName, errorText, shortHost } from "./lib";

type View = "overview" | "sql" | "profiles";

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; ws: Workspace }
  | { kind: "remove"; ws: Workspace }
  | { kind: "signing-in"; ws: Workspace }
  | null;

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState("");
  // Bumped after a sign-in so the overview reloads with the new credentials.
  const [authEpoch, setAuthEpoch] = useState(0);
  // The SQL view stays mounted once opened so results survive switching views.
  const [sqlOpened, setSqlOpened] = useState(false);

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
      setView((v) => (v === "profiles" ? "overview" : v));
    });

  const signIn = async (ws: Workspace, fn: (profile: string) => Promise<void>) => {
    setDialog({ kind: "signing-in", ws });
    await run(() => fn(ws.profile.name));
    setDialog(null);
    setAuthEpoch((n) => n + 1);
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
              aria-current={ws.active && view !== "profiles" ? "true" : undefined}
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
        <button
          className="rail-item"
          aria-current={view === "profiles" ? "true" : undefined}
          onClick={() => setView("profiles")}
        >
          <span className="name">Manage profiles</span>
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
                    setSqlOpened(true);
                    setView("sql");
                  }}
                >
                  SQL
                </button>
              </div>
            </>
          ) : (
            <div className="who">
              <strong>dbx-desktop</strong>
            </div>
          )}
        </header>

        {active && sqlOpened && (
          <div className="content flush" hidden={view !== "sql"}>
            <SqlView key={`${active.profile.name}:${authEpoch}`} workspace={active} visible={view === "sql"} />
          </div>
        )}

        <main className="content" hidden={view === "sql" && !!active}>
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

          {view === "profiles" ? (
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
              authEpoch={authEpoch}
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
