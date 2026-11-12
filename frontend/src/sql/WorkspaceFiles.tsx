import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NotebookService, SQLService, type WorkspaceItem, type WorkspacePlaces } from "../../bindings/dbx-desktop";
import { Modal } from "../dialogs";
import { errorText, relativeTime } from "../lib";
import { crumbs, notebookName, sqlName } from "./wspath";

/**
 * What the workspace browser lists and saves: .sql files for the SQL
 * scratchpad, or Python notebooks for the notebook view.
 */
export interface WorkspaceKind {
  /** "file" or "notebook", for messages. */
  noun: string;
  places(profile: string): Promise<WorkspacePlaces>;
  list(profile: string, folder: string): Promise<WorkspaceItem[] | null>;
  /** What is at a path: "" for nothing, "file" for an item of this kind. */
  itemKind(profile: string, path: string): Promise<string>;
  /** The name a typed name is saved as, or "" when it is unusable. */
  targetName(name: string): string;
  /** How the saved item is described under the name field. */
  savedAs(target: string): ReactNode;
  emptyFolder: string;
  /** Where the name field's selection ends, to preselect the name without an extension. */
  nameEnd(value: string): number;
}

export const SQL_FILES: WorkspaceKind = {
  noun: "file",
  places: (p) => SQLService.WorkspacePlaces(p),
  list: (p, f) => SQLService.ListWorkspace(p, f),
  itemKind: (p, path) => SQLService.WorkspaceItemKind(p, path),
  targetName: sqlName,
  savedAs: (t) => (
    <>
      Saved as a workspace file, <span className="mono">{t || "name.sql"}</span>.
    </>
  ),
  emptyFolder: "No folders or .sql files here.",
  nameEnd: (v) => {
    const dot = v.toLowerCase().lastIndexOf(".sql");
    return dot > 0 ? dot : v.length;
  },
};

export const NOTEBOOKS: WorkspaceKind = {
  noun: "notebook",
  places: (p) => NotebookService.NotebookPlaces(p),
  list: (p, f) => NotebookService.ListNotebookFolder(p, f),
  itemKind: (p, path) => NotebookService.NotebookItemKind(p, path),
  targetName: notebookName,
  savedAs: (t) => (
    <>
      Saved as a Python notebook, <span className="mono">{t || "name"}</span>.
    </>
  ),
  emptyFolder: "No folders or Python notebooks here.",
  nameEnd: (v) => v.length,
};

export type IconKind = "folder" | "repo" | "file" | "home" | "up" | "reload" | "cloud" | "computer" | "trash";

const paths: Record<IconKind, ReactNode> = {
  folder: <path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />,
  repo: (
    <>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="6" r="1.5" />
      <path d="M5 5.5v5M11 7.5c0 2-3 2-6 3" />
    </>
  ),
  file: (
    <>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </>
  ),
  home: <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5" />,
  up: <path d="M8 13V3.5M4 7l4-4 4 4" />,
  reload: (
    <>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  cloud: <path d="M4.5 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 11.8 5.6 3.5 3.5 0 0 1 11.5 12.5z" />,
  computer: (
    <>
      <rect x="2.5" y="3" width="11" height="7.5" rx="1" />
      <path d="M1.5 13h13" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.5h11M6 4.5V3h4v1.5" />
      <path d="M3.8 4.5 4.5 13.5h7l.7-9M6.7 7v4M9.3 7v4" />
    </>
  ),
};

export function WsIcon(props: { kind: IconKind; className?: string }) {
  return (
    <svg
      className={`icon ${props.className ?? ""}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[props.kind]}
    </svg>
  );
}

type Load = { state: "loading" | "ready" | "error"; items: WorkspaceItem[]; error: string };

/** Breadcrumbs, Home and Up for a workspace folder. */
function FolderNav(props: { folder: string; home: string; onFolder: (path: string) => void; onReload: () => void }) {
  const parts = crumbs(props.folder);
  return (
    <div className="ws-nav">
      <div className="cat-row">
        <button
          type="button"
          className="icon-btn"
          title="Home folder"
          aria-label="Home folder"
          disabled={!props.home || props.folder === props.home}
          onClick={() => props.onFolder(props.home)}
        >
          <WsIcon kind="home" />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Up one folder"
          aria-label="Up one folder"
          disabled={parts.length < 2}
          onClick={() => props.onFolder(parts[parts.length - 2].path)}
        >
          <WsIcon kind="up" />
        </button>
        <span className="toolbar-gap" />
        <button type="button" className="icon-btn" title="Reload" aria-label="Reload" onClick={props.onReload}>
          <WsIcon kind="reload" />
        </button>
      </div>
      <nav className="ws-crumbs" aria-label="Workspace folder">
        {parts.map((c, i) => (
          <span key={c.path}>
            {i === parts.length - 1 ? (
              <strong aria-current="location">{c.name}</strong>
            ) : (
              <>
                <button type="button" className="ws-crumb" onClick={() => props.onFolder(c.path)}>
                  {c.name}
                </button>
                <span className="ws-sep">/</span>
              </>
            )}
          </span>
        ))}
      </nav>
    </div>
  );
}

/** The folders and files (or notebooks) in one workspace folder. */
function FolderList(props: {
  kind: WorkspaceKind;
  profile: string;
  folder: string;
  reloadKey: number;
  /** The workspace path to mark as current. */
  current?: string;
  onFolder: (path: string) => void;
  onFile: (item: WorkspaceItem) => void;
  fileTitle: string;
  empty: string;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading", items: [], error: "" });
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading", items: [], error: "" });
    props.kind.list(props.profile, props.folder)
      .then((items) => live && setLoad({ state: "ready", items: items ?? [], error: "" }))
      .catch((e) => live && setLoad({ state: "error", items: [], error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [props.kind, props.profile, props.folder, props.reloadKey]);

  if (load.state === "loading") return <div className="tree-note">Loading…</div>;
  if (load.state === "error") return <div className="tree-note error">{load.error}</div>;
  if (load.items.length === 0) return <div className="tree-note">{props.empty}</div>;
  return (
    <ul className="tree" role="tree">
      {load.items.map((it) => (
        <li key={it.path} role="treeitem">
          <div className="tree-row">
            <button
              type="button"
              className="tree-main"
              aria-current={it.path === props.current ? "true" : undefined}
              title={it.kind === "file" ? `${props.fileTitle} ${it.path}` : it.path}
              onClick={() => (it.kind === "file" ? props.onFile(it) : props.onFolder(it.path))}
            >
              <WsIcon kind={it.kind as IconKind} className={`kind-ws-${it.kind}`} />
              <span className="tree-name">{it.name}</span>
              {it.kind === "file" && <span className="tree-hint">{relativeTime(it.modified)}</span>}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function usePlaces(kind: WorkspaceKind, profile: string, reloadKey: number) {
  const [places, setPlaces] = useState<WorkspacePlaces | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    kind.places(profile)
      .then((p) => {
        if (!live) return;
        setPlaces(p);
        setError("");
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [kind, profile, reloadKey]);
  return { places, error };
}

/** The Workspace side panel: recent workspace files and a folder browser. */
export function WorkspacePanel(props: {
  kind?: WorkspaceKind;
  profile: string;
  /** Changes whenever a file is saved, so the lists refresh. */
  reloadKey: number;
  current?: string;
  onOpen: (remotePath: string) => void;
}) {
  const kind = props.kind ?? SQL_FILES;
  const [retry, setRetry] = useState(0);
  const { places, error } = usePlaces(kind, props.profile, props.reloadKey + retry);
  const [folder, setFolder] = useState("");
  const [listKey, setListKey] = useState(0);

  // Start in the folder last saved to.
  useEffect(() => {
    if (places && !folder) setFolder(places.lastFolder || places.home);
  }, [places, folder]);
  useEffect(() => setFolder(""), [props.profile]);

  if (error && !places) {
    return (
      <div className="side-body">
        <div className="tree-note error">
          {error}{" "}
          <button className="link" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!places || !folder) {
    return (
      <div className="side-body">
        <div className="tree-note">Loading…</div>
      </div>
    );
  }
  const recent = (places.recent ?? []).slice(0, 8);
  return (
    <div className="side-body ws">
      {recent.length > 0 && (
        <section aria-label="Recent workspace files">
          <h3 className="ws-heading">Recent</h3>
          <ul className="side-list">
            {recent.map((r) => (
              <li key={r.path}>
                <button
                  onClick={() => props.onOpen(r.path)}
                  title={r.path}
                  aria-current={r.path === props.current ? "true" : undefined}
                >
                  <span className="ws-recent-name">
                    <span className="tree-name">{r.name}</span>
                    {r.unsaved && (
                      <span
                        className="unsaved remote"
                        title="Has edits not saved to the workspace"
                        aria-label="not saved to the workspace"
                      >
                        ●
                      </span>
                    )}
                  </span>
                  <span className="tree-hint">{relativeTime(r.opened)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Browse the workspace">
        <h3 className="ws-heading">Browse</h3>
        <FolderNav
          folder={folder}
          home={places.home}
          onFolder={setFolder}
          onReload={() => setListKey((n) => n + 1)}
        />
        <FolderList
          kind={kind}
          profile={props.profile}
          folder={folder}
          reloadKey={listKey + props.reloadKey}
          current={props.current}
          onFolder={setFolder}
          onFile={(it) => props.onOpen(it.path)}
          fileTitle="Open"
          empty={kind.emptyFolder}
        />
      </section>
    </div>
  );
}

/**
 * Chooses a workspace folder and name, then calls onSave to upload there.
 * onSave throws to show an error and keep the dialog open.
 */
export function SaveToWorkspaceDialog(props: {
  kind?: WorkspaceKind;
  profile: string;
  defaultName: string;
  /** Extra sentence under the name field, such as what happens to the scratch copy. */
  note?: string;
  onClose: () => void;
  onSave: (folder: string, name: string) => Promise<void>;
}) {
  const kind = props.kind ?? SQL_FILES;
  const { places, error: placesError } = usePlaces(kind, props.profile, 0);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState(props.defaultName);
  const [listKey, setListKey] = useState(0);
  const [replace, setReplace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (places && !folder) setFolder(places.lastFolder || places.home);
  }, [places, folder]);

  const target = kind.targetName(name);
  // Any change to the target cancels a pending "replace" confirmation.
  const changeFolder = useCallback((f: string) => {
    setFolder(f);
    setReplace("");
    setError("");
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!folder || !target) return;
    const path = `${folder.replace(/\/$/, "")}/${target}`;
    setBusy(true);
    setError("");
    try {
      if (replace !== path) {
        const there = await kind.itemKind(props.profile, path);
        if (there === "file") {
          setReplace(path);
          setBusy(false);
          return;
        }
        if (there) {
          setError(`${target} is a ${there} in this folder. Choose another name.`);
          setBusy(false);
          return;
        }
      }
      await props.onSave(folder, target);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Save to workspace" onClose={props.onClose} locked={busy}>
      <form onSubmit={submit}>
        <div className="dialog-body ws-save">
          <div className="field">
            <span className="label">Folder</span>
            {placesError && !places ? (
              <div className="tree-note error">{placesError}</div>
            ) : !folder || !places ? (
              <div className="tree-note">Loading…</div>
            ) : (
              <div className="ws-picker">
                <FolderNav
                  folder={folder}
                  home={places.home}
                  onFolder={changeFolder}
                  onReload={() => setListKey((n) => n + 1)}
                />
                <div className="ws-picker-list">
                  <FolderList
                    kind={kind}
                    profile={props.profile}
                    folder={folder}
                    reloadKey={listKey}
                    onFolder={changeFolder}
                    onFile={(it) => {
                      setName(it.name);
                      setReplace("");
                    }}
                    fileTitle="Use the name of"
                    empty="This folder is empty."
                  />
                </div>
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="ws-name">Name</label>
            <input
              id="ws-name"
              className="input"
              autoFocus
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setReplace("");
                setError("");
              }}
              onFocus={(e) => e.target.setSelectionRange(0, kind.nameEnd(e.target.value))}
            />
            <span className="hint">
              {kind.savedAs(target)} {props.note ?? "The scratch copy is removed once it is saved."}
            </span>
          </div>
          {replace && (
            <p className="ws-warn" role="alert">
              <strong>{target}</strong> already exists in this folder. Save again to replace it.
            </p>
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
          <button
            type="submit"
            className={replace ? "btn danger" : "btn primary"}
            disabled={busy || !folder || !target}
          >
            {busy ? "Saving…" : replace ? "Replace" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Asks what to do when the workspace file changed or vanished since it was downloaded. */
export function ConflictDialog(props: {
  name: string;
  remotePath: string;
  missing: boolean;
  onClose: () => void;
  onOverwrite: () => void;
  onLoadRemote: () => void;
}) {
  return (
    <Modal title={props.missing ? `${props.name} is no longer in the workspace` : `${props.name} changed in the workspace`} onClose={props.onClose}>
      <div className="dialog-body">
        {props.missing ? (
          <p>
            <span className="mono">{props.remotePath}</span> was deleted or moved since you opened it. Saving creates
            it again at that path.
          </p>
        ) : (
          <p>
            Someone changed <span className="mono">{props.remotePath}</span> in Databricks since you opened it. Replace
            their version with yours, or load theirs and discard your edits.
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" onClick={props.onClose} autoFocus>
          Cancel
        </button>
        {!props.missing && (
          <button type="button" className="btn" onClick={props.onLoadRemote}>
            Load workspace version
          </button>
        )}
        <button type="button" className={props.missing ? "btn primary" : "btn danger"} onClick={props.onOverwrite}>
          {props.missing ? "Save it again" : "Replace with mine"}
        </button>
      </div>
    </Modal>
  );
}
