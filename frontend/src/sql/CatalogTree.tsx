import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SQLService } from "../../bindings/dbx-desktop";
import { errorText } from "../lib";
import { qualified, quoteIdent } from "./csv";

type Load<T> = { state: "idle" | "loading" | "ready" | "error"; items: T[]; error: string };

const idle = { state: "idle" as const, items: [], error: "" };

/** Loads children the first time a node is opened. */
function useLazy<T>(fetcher: () => Promise<T[] | null>) {
  const [load, setLoad] = useState<Load<T>>(idle);
  const [open, setOpen] = useState(false);

  const fetchNow = useCallback(async () => {
    setLoad({ state: "loading", items: [], error: "" });
    try {
      setLoad({ state: "ready", items: (await fetcher()) ?? [], error: "" });
    } catch (e) {
      setLoad({ state: "error", items: [], error: errorText(e) });
    }
  }, [fetcher]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && (load.state === "idle" || load.state === "error")) fetchNow();
  };
  return { load, open, toggle, fetchNow };
}

function Branch(props: {
  label: string;
  hint?: string;
  depth: number;
  open: boolean;
  onToggle: () => void;
  /** When set, clicking the label inserts text and only the arrow expands. */
  onInsert?: () => void;
  children?: ReactNode;
}) {
  const pad = { paddingLeft: 6 + props.depth * 14 };
  return (
    <li role="treeitem" aria-expanded={props.open}>
      <div className="tree-row" style={pad}>
        <button
          className="tree-arrow"
          aria-label={props.open ? `Collapse ${props.label}` : `Expand ${props.label}`}
          onClick={props.onToggle}
        >
          {props.open ? "▾" : "▸"}
        </button>
        <button
          className="tree-label"
          title={props.onInsert ? `Insert ${props.label} into the query` : props.label}
          onClick={props.onInsert ?? props.onToggle}
        >
          <span className="tree-name">{props.label}</span>
          {props.hint && <span className="tree-hint">{props.hint}</span>}
        </button>
      </div>
      {props.open && <ul role="group">{props.children}</ul>}
    </li>
  );
}

function Status<T>(props: { load: Load<T>; depth: number; empty: string; onRetry: () => void }) {
  const pad = { paddingLeft: 26 + props.depth * 14 };
  if (props.load.state === "loading") {
    return (
      <li className="tree-note" style={pad}>
        Loading…
      </li>
    );
  }
  if (props.load.state === "error") {
    return (
      <li className="tree-note error" style={pad}>
        {props.load.error}{" "}
        <button className="link" onClick={props.onRetry}>
          Retry
        </button>
      </li>
    );
  }
  if (props.load.state === "ready" && props.load.items.length === 0) {
    return (
      <li className="tree-note" style={pad}>
        {props.empty}
      </li>
    );
  }
  return null;
}

function TableNode(props: {
  profile: string;
  catalog: string;
  schema: string;
  name: string;
  type: string;
  onInsert: (text: string) => void;
}) {
  const full = [props.catalog, props.schema, props.name].join(".");
  const fetcher = useCallback(() => SQLService.TableColumns(props.profile, full), [props.profile, full]);
  const { load, open, toggle, fetchNow } = useLazy(fetcher);
  const hint = props.type === "VIEW" || props.type === "MATERIALIZED_VIEW" ? "view" : undefined;
  return (
    <Branch
      label={props.name}
      hint={hint}
      depth={2}
      open={open}
      onToggle={toggle}
      onInsert={() => props.onInsert(qualified(props.catalog, props.schema, props.name))}
    >
      <Status load={load} depth={3} empty="No columns." onRetry={fetchNow} />
      {load.items.map((c) => (
        <li key={c.name} role="treeitem">
          <div className="tree-row" style={{ paddingLeft: 26 + 3 * 14 }}>
            <button
              className="tree-label"
              title={`Insert ${c.name} into the query`}
              onClick={() => props.onInsert(quoteIdent(c.name))}
            >
              <span className="tree-name">{c.name}</span>
              <span className="tree-hint">{c.type}</span>
            </button>
          </div>
        </li>
      ))}
    </Branch>
  );
}

function SchemaNode(props: { profile: string; catalog: string; name: string; onInsert: (text: string) => void }) {
  const fetcher = useCallback(
    () => SQLService.ListTables(props.profile, props.catalog, props.name),
    [props.profile, props.catalog, props.name],
  );
  const { load, open, toggle, fetchNow } = useLazy(fetcher);
  return (
    <Branch label={props.name} depth={1} open={open} onToggle={toggle}>
      <Status load={load} depth={2} empty="No tables." onRetry={fetchNow} />
      {load.items.map((t) => (
        <TableNode
          key={t.name}
          profile={props.profile}
          catalog={props.catalog}
          schema={props.name}
          name={t.name}
          type={t.type}
          onInsert={props.onInsert}
        />
      ))}
    </Branch>
  );
}

function CatalogNode(props: { profile: string; name: string; onInsert: (text: string) => void }) {
  const fetcher = useCallback(() => SQLService.ListSchemas(props.profile, props.name), [props.profile, props.name]);
  const { load, open, toggle, fetchNow } = useLazy(fetcher);
  return (
    <Branch label={props.name} depth={0} open={open} onToggle={toggle}>
      <Status load={load} depth={1} empty="No schemas." onRetry={fetchNow} />
      {load.items.map((s) => (
        <SchemaNode key={s} profile={props.profile} catalog={props.name} name={s} onInsert={props.onInsert} />
      ))}
    </Branch>
  );
}

/** Unity Catalog browser. Clicking a table or column inserts its name. */
export function CatalogTree(props: { profile: string; onInsert: (text: string) => void }) {
  const [load, setLoad] = useState<Load<string>>(idle);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading", items: [], error: "" });
    SQLService.ListCatalogs(props.profile)
      .then((items) => live && setLoad({ state: "ready", items: items ?? [], error: "" }))
      .catch((e) => live && setLoad({ state: "error", items: [], error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [props.profile, epoch]);

  return (
    <div className="side-body">
      <div className="side-tools">
        <span className="muted">Click a name to insert it.</span>
        <button className="btn small" onClick={() => setEpoch((n) => n + 1)}>
          Reload
        </button>
      </div>
      <ul className="tree" role="tree" aria-label="Catalogs">
        <Status load={load} depth={-1} empty="No catalogs." onRetry={() => setEpoch((n) => n + 1)} />
        {load.items.map((c) => (
          <CatalogNode key={`${epoch}:${c}`} profile={props.profile} name={c} onInsert={props.onInsert} />
        ))}
      </ul>
    </div>
  );
}
