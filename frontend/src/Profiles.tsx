import type { Workspace } from "../bindings/dbx-desktop";
import { authLabel, shortHost } from "./lib";

export function Profiles(props: {
  workspaces: Workspace[];
  configPath: string;
  cliReady: boolean;
  onAdd: () => void;
  onEdit: (ws: Workspace) => void;
  onRemove: (ws: Workspace) => void;
  onSignIn: (ws: Workspace) => void;
  onSwitchToOAuth: (ws: Workspace) => void;
  onSetDefault: (ws: Workspace) => void;
}) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Profiles</h1>
          <p className="muted">
            Stored in <span className="mono">{props.configPath}</span>, shared with the Databricks CLI and SDKs.
          </p>
        </div>
        <button className="btn primary" onClick={props.onAdd}>
          Add workspace
        </button>
      </div>

      <div className="card">
        {props.workspaces.length === 0 ? (
          <div className="empty">No profiles yet.</div>
        ) : (
          <ul className="list profiles">
            {props.workspaces.map((ws) => {
              const p = ws.profile;
              const oauth = p.authType === "databricks-cli";
              return (
                <li key={p.name}>
                  <div className="grow">
                    <div className="row">
                      <span className="dot" style={{ ["--dot" as string]: ws.meta.color }} aria-hidden="true" />
                      <strong>{p.name}</strong>
                      {ws.meta.nickname && <span className="muted">{ws.meta.nickname}</span>}
                      {ws.meta.prod && <span className="badge prod">Prod</span>}
                      {p.isDefault && (
                        <span className="badge" title="The CLI uses this profile when none is named">
                          CLI default
                        </span>
                      )}
                      {p.isAccount && <span className="badge">Account</span>}
                      {p.hasToken ? (
                        <span className="badge warn" title="A token is stored in plain text in the config file">
                          Plain-text token
                        </span>
                      ) : (
                        <span className="badge">{authLabel(p.authType)}</span>
                      )}
                    </div>
                    <div className="sub mono">{shortHost(p.host) || "No host set"}</div>
                  </div>
                  <div className="row actions">
                    {p.hasToken && (
                      <button className="btn small" disabled={!props.cliReady} onClick={() => props.onSwitchToOAuth(ws)}>
                        Switch to OAuth
                      </button>
                    )}
                    {oauth && (
                      <button className="btn small" disabled={!props.cliReady} onClick={() => props.onSignIn(ws)}>
                        Sign in again
                      </button>
                    )}
                    {!p.isDefault && (
                      <button className="btn small" onClick={() => props.onSetDefault(ws)}>
                        Make CLI default
                      </button>
                    )}
                    <button className="btn small" onClick={() => props.onEdit(ws)}>
                      Edit
                    </button>
                    <button className="btn small danger" onClick={() => props.onRemove(ws)}>
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
