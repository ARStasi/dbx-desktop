import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { WorkspaceService, type Workspace } from "../bindings/dbx-desktop";
import type { WorkspaceMeta } from "../bindings/dbx-desktop/internal/settings/models";
import { displayName, errorText, shortHost } from "./lib";

/** A modal built on the native dialog element, which handles focus and Esc. */
export function Modal(props: {
  title: string;
  onClose: () => void;
  /** Blocks Esc and backdrop dismissal, for example while a sign-in is waiting. */
  locked?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // A layout effect, so the dialog is closed before it leaves the page.
  // Closing it is what hands focus back to wherever it was, such as the editor.
  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={props.title}
      onCancel={(e) => {
        e.preventDefault();
        if (!props.locked) props.onClose();
      }}
    >
      <div className="dialog-head">
        <h2>{props.title}</h2>
      </div>
      {props.children}
    </dialog>
  );
}

export function AddWorkspaceDialog(props: {
  cliReady: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [host, setHost] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [method, setMethod] = useState<"oauth" | "token">(props.cliReady ? "oauth" : "token");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Suggest a profile name from the URL until the user types their own.
  useEffect(() => {
    if (nameEdited || !host.trim()) return;
    const t = setTimeout(() => {
      WorkspaceService.SuggestProfileName(host)
        .then((n) => setName(n))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [host, nameEdited]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (method === "oauth") {
        await WorkspaceService.AddWorkspaceOAuth(host, name.trim());
      } else {
        await WorkspaceService.AddWorkspaceToken(host, name.trim(), token);
      }
      props.onAdded();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const waiting = busy && method === "oauth";

  return (
    <Modal title="Add workspace" onClose={props.onClose} locked={busy}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          {waiting ? (
            <div className="waiting" role="status">
              <span className="spinner" aria-hidden="true" />
              <div>
                <strong>Finish signing in in your browser</strong>
                <div className="muted">
                  A sign-in page opened for {shortHost(host)}. This window updates when you are done.
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="add-host">Workspace URL</label>
                <input
                  id="add-host"
                  className="input"
                  autoFocus
                  required
                  placeholder="https://dbc-12345678-abcd.cloud.databricks.com"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
                <span className="hint">Paste any URL from the workspace. Only the host is kept.</span>
              </div>
              <div className="field">
                <label htmlFor="add-name">Profile name</label>
                <input
                  id="add-name"
                  className="input"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameEdited(true);
                  }}
                />
                <span className="hint">
                  The name in your Databricks config file, used as <span className="mono">--profile</span> by the CLI.
                </span>
              </div>
              <div className="field">
                <span className="label">Sign in with</span>
                <div className="choice" role="radiogroup" aria-label="Sign in with">
                  <label>
                    <input
                      type="radio"
                      name="method"
                      checked={method === "oauth"}
                      disabled={!props.cliReady}
                      onChange={() => setMethod("oauth")}
                    />
                    Browser (OAuth)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="method"
                      checked={method === "token"}
                      onChange={() => setMethod("token")}
                    />
                    Access token
                  </label>
                </div>
                {!props.cliReady && (
                  <span className="hint">Browser sign-in needs the Databricks CLI, which was not found.</span>
                )}
              </div>
              {method === "token" && (
                <div className="field">
                  <label htmlFor="add-token">Personal access token</label>
                  <input
                    id="add-token"
                    className="input mono"
                    type="password"
                    required
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <span className="hint">
                    The token is saved in plain text in your Databricks config file, the same as the CLI does. Browser
                    sign-in stores no token there.
                  </span>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-foot">
          {waiting ? (
            <button type="button" className="btn" onClick={() => WorkspaceService.CancelLogin()}>
              Cancel sign-in
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={props.onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {method === "oauth" ? "Sign in" : "Add workspace"}
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function EditWorkspaceDialog(props: {
  workspace: Workspace;
  palette: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const ws = props.workspace;
  const [meta, setMeta] = useState<WorkspaceMeta>({ ...ws.meta });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await WorkspaceService.UpdateMeta(ws.profile.name, meta);
      props.onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${ws.profile.name}`} onClose={props.onClose} locked={busy}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <div className="field">
            <label htmlFor="edit-nick">Nickname</label>
            <input
              id="edit-nick"
              className="input"
              autoFocus
              placeholder={ws.profile.name}
              value={meta.nickname}
              onChange={(e) => setMeta({ ...meta, nickname: e.target.value })}
            />
            <span className="hint">Shown in the app in place of the profile name.</span>
          </div>
          <div className="field">
            <span className="label">Color</span>
            <div className="swatches" role="radiogroup" aria-label="Color">
              {props.palette.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={meta.color === c}
                  aria-label={c}
                  className="swatch"
                  style={{ ["--dot" as string]: c }}
                  onClick={() => setMeta({ ...meta, color: c })}
                />
              ))}
            </div>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={meta.prod}
              onChange={(e) => setMeta({ ...meta, prod: e.target.checked })}
            />
            <span>
              <strong>Production workspace</strong>
              <br />
              <span className="muted">Actions that change this workspace ask for extra confirmation.</span>
            </span>
          </label>
          <div className="field">
            <label htmlFor="edit-volume">Default volume for file uploads</label>
            <input
              id="edit-volume"
              className="input mono"
              placeholder="catalog.schema.volume"
              value={meta.defaultVolume}
              onChange={(e) => setMeta({ ...meta, defaultVolume: e.target.value })}
            />
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RemoveWorkspaceDialog(props: {
  workspace: Workspace;
  configPath: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const ws = props.workspace;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Production workspaces need the profile name typed out.
  const confirmed = !ws.meta.prod || typed === ws.profile.name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await WorkspaceService.RemoveWorkspace(ws.profile.name);
      props.onRemoved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Remove ${displayName(ws)}?`} onClose={props.onClose} locked={busy}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <p>
            This deletes the <span className="mono">[{ws.profile.name}]</span> profile from{" "}
            <span className="mono">{props.configPath}</span>. The CLI and other tools will stop seeing it too. Nothing
            in the workspace itself changes.
          </p>
          <p className="muted">
            The previous version of the file is kept next to it, with <span className="mono">.bak</span> added to
            its name.
          </p>
          {ws.meta.prod && (
            <div className="field">
              <label htmlFor="remove-confirm">
                Type <span className="mono">{ws.profile.name}</span> to confirm
              </label>
              <input
                id="remove-confirm"
                className="input mono"
                autoFocus
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={busy || !confirmed}>
            Remove profile
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Shown while a browser sign-in for an existing profile is waiting. */
export function SigningInDialog(props: { host: string }) {
  return (
    <Modal title="Signing in" onClose={() => {}} locked>
      <div className="dialog-body">
        <div className="waiting" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>Finish signing in in your browser</strong>
            <div className="muted">A sign-in page opened for {shortHost(props.host)}.</div>
          </div>
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" onClick={() => WorkspaceService.CancelLogin()}>
          Cancel sign-in
        </button>
      </div>
    </Modal>
  );
}

/**
 * Asks before an action that is destructive or costs money. Pass requireText
 * to make the user type a name first, which production workspaces use.
 */
export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = !props.requireText || typed === props.requireText;
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onConfirm();
        }}
      >
        <div className="dialog-body">
          {props.children}
          {props.requireText && (
            <div className="field">
              <label htmlFor="confirm-text">
                Type <span className="mono">{props.requireText}</span> to confirm
              </label>
              <input
                id="confirm-text"
                className="input mono"
                autoFocus
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={props.onClose} autoFocus={!props.requireText}>
            Cancel
          </button>
          <button type="submit" className={props.danger ? "btn danger" : "btn primary"} disabled={!ok}>
            {props.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
