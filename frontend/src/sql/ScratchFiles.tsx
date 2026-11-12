import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { File as QueryFile } from "../../bindings/dbx-desktop/internal/queries/models";
import { relativeTime } from "../lib";
import { nextSelection } from "./selection";
import { WsIcon } from "./WorkspaceFiles";

/**
 * The header that says where a side panel's files live: Scratch drafts on
 * this computer, or Workspace files in Databricks.
 */
export function PlaceBanner(props: {
  kind: "scratch" | "workspace";
  title: string;
  detail: string;
  detailTitle?: string;
  children: ReactNode;
}) {
  return (
    <header className={`place place-${props.kind}`}>
      <div className="place-head">
        <WsIcon kind={props.kind === "scratch" ? "computer" : "cloud"} className="place-icon" />
        <strong>{props.title}</strong>
        <span
          className={`place-detail mono${props.kind === "scratch" ? " path" : ""}`}
          title={props.detailTitle ?? props.detail}
        >
          <bdi>{props.detail}</bdi>
        </span>
      </div>
      <p className="place-hint">{props.children}</p>
    </header>
  );
}

const modKey = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";

/** The Scratch side panel: local query files, with multi-select delete. */
export function ScratchPanel(props: {
  files: QueryFile[];
  /** Path of the file in the active tab. */
  current?: string;
  onOpen: (path: string) => void;
  onDelete: (paths: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const allBox = useRef<HTMLInputElement>(null);
  const order = props.files.map((f) => f.path);

  // Forget selected files that are gone, for example after a delete.
  const orderKey = order.join("\n");
  useEffect(() => {
    const present = new Set(orderKey ? orderKey.split("\n") : []);
    setSelected((s) => {
      const kept = [...s].filter((p) => present.has(p));
      return kept.length === s.size ? s : new Set(kept);
    });
    if (anchor.current && !present.has(anchor.current)) anchor.current = null;
  }, [orderKey]);

  const count = selected.size;
  const all = count > 0 && count === order.length;
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = count > 0 && !all;
  }, [count, all]);

  const toggle = (path: string, shift: boolean) => {
    const from = anchor.current;
    setSelected((s) => nextSelection(order, s, from, path, shift));
    if (!shift || !from) anchor.current = path;
  };

  const onRowClick = (e: MouseEvent, path: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || count > 0) {
      e.preventDefault();
      toggle(path, e.shiftKey);
      return;
    }
    props.onOpen(path);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") return;
    if ((e.key === "Delete" || e.key === "Backspace") && count > 0) {
      e.preventDefault();
      props.onDelete(order.filter((p) => selected.has(p)));
    } else if (e.key === "Escape" && count > 0) {
      e.preventDefault();
      setSelected(new Set());
    } else if (e.key.toLowerCase() === "a" && (e.metaKey || e.ctrlKey) && order.length > 0) {
      e.preventDefault();
      setSelected(new Set(order));
    }
  };

  if (props.files.length === 0) {
    return <div className="tree-note">No scratch queries yet. Use ＋ above the editor to start one.</div>;
  }

  return (
    <div className="scratch" onKeyDown={onKeyDown}>
      <div className={`scratch-bar${count ? " selecting" : ""}`}>
        <input
          ref={allBox}
          type="checkbox"
          aria-label={all ? "Clear selection" : "Select all scratch files"}
          title={all ? "Clear selection" : `Select all (${modKey}A)`}
          checked={all}
          onChange={() => setSelected(all ? new Set() : new Set(order))}
        />
        {count > 0 ? (
          <>
            <span className="scratch-count">{count} selected</span>
            <span className="toolbar-gap" />
            <button type="button" className="btn small" onClick={() => setSelected(new Set())}>
              Cancel
            </button>
            <button
              type="button"
              className="btn small danger"
              onClick={() => props.onDelete(order.filter((p) => selected.has(p)))}
            >
              Delete
            </button>
          </>
        ) : (
          <span className="muted scratch-count">
            {order.length} {order.length === 1 ? "file" : "files"} · {modKey}-click to select
          </span>
        )}
      </div>
      <ul className="side-list scratch-list" aria-multiselectable="true" aria-label="Scratch files">
        {props.files.map((f) => {
          const on = selected.has(f.path);
          return (
            <li key={f.path} className={on ? "selected" : undefined}>
              <input
                type="checkbox"
                className="scratch-check"
                aria-label={`Select ${f.name}`}
                checked={on}
                onChange={() => {}}
                onClick={(e) => toggle(f.path, e.shiftKey)}
              />
              <button
                onClick={(e) => onRowClick(e, f.path)}
                aria-current={f.path === props.current ? "true" : undefined}
                aria-pressed={count > 0 ? on : undefined}
                title={f.path}
              >
                <span className="tree-name">{f.name}</span>
                <span className="tree-hint">{relativeTime(f.modified)}</span>
              </button>
              <button
                type="button"
                className="icon-btn scratch-del"
                title={`Delete ${f.name}`}
                aria-label={`Delete ${f.name}`}
                onClick={() => props.onDelete([f.path])}
              >
                <WsIcon kind="trash" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
