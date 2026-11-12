import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SQLService, type TableRef } from "../../bindings/dbx-desktop";
import type { Column } from "../../bindings/dbx-desktop/internal/sqlexec/models";
import { errorText } from "../lib";
import { matches, pickCurrent, shownCatalogs } from "./catalogs";
import { qualified, quoteIdent } from "./csv";

type Load<T> = { state: "idle" | "loading" | "ready" | "error"; items: T[]; error: string };

const idle = { state: "idle" as const, items: [], error: "" };
const loading = { state: "loading" as const, items: [], error: "" };

type Prefs = { visible: string[]; current: string };

// ---------- Icons ----------

type IconKind =
  | "catalog"
  | "schema"
  | "table"
  | "view"
  | "column"
  | "chevron"
  | "insert"
  | "funnel"
  | "reload"
  | "collapse";

const paths: Record<IconKind, ReactNode> = {
  catalog: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  schema: (
    <>
      <path d="M2 5.5 8 2.5l6 3-6 3z" />
      <path d="M2 8.5l6 3 6-3" />
      <path d="M2 11.5l6 3 6-3" />
    </>
  ),
  table: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5V13" />
    </>
  ),
  view: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  column: <rect x="5.5" y="2.5" width="5" height="11" rx="1" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  insert: (
    <>
      <path d="M2.5 8h8M7.5 5l3 3-3 3" />
      <path d="M13.5 3v10" />
    </>
  ),
  funnel: <path d="M2.5 3h11l-4.25 5v4.5l-2.5 1V8z" />,
  reload: (
    <>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  collapse: <path d="M4.5 2.5 8 5.5l3.5-3M4.5 13.5 8 10.5l3.5 3" />,
};

function Icon(props: { kind: IconKind; className?: string }) {
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

// ---------- Tree rows ----------

function Row(props: {
  depth: number;
  icon: IconKind;
  label: string;
  hint?: string;
  /** Present on nodes that have children. */
  open?: boolean;
  onToggle?: () => void;
  onInsert?: () => void;
  insertText?: string;
  children?: ReactNode;
}) {
  const expandable = props.onToggle !== undefined;
  return (
    <li role="treeitem" aria-expanded={expandable ? props.open : undefined}>
      <div className="tree-row" style={{ ["--depth" as string]: props.depth }}>
        <button
          className="tree-main"
          onClick={expandable ? props.onToggle : props.onInsert}
          title={expandable ? props.label : `Insert ${props.insertText ?? props.label}`}
        >
          {expandable ? (
            <Icon kind="chevron" className={props.open ? "tree-chev open" : "tree-chev"} />
          ) : (
            <span className="tree-chev" />
          )}
          <Icon kind={props.icon} className={`kind-${props.icon}`} />
          <span className="tree-name">{props.label}</span>
          {props.hint && <span className="tree-hint">{props.hint}</span>}
        </button>
        {props.onInsert && expandable && (
          <button
            className="tree-insert"
            aria-label={`Insert ${props.label}`}
            title={`Insert ${props.insertText ?? props.label}`}
            onClick={props.onInsert}
          >
            <Icon kind="insert" />
          </button>
        )}
      </div>
      {expandable && props.open && <ul role="group">{props.children}</ul>}
    </li>
  );
}

function Note(props: { depth: number; error?: boolean; children: ReactNode }) {
  return (
    <li className={props.error ? "tree-note error" : "tree-note"} style={{ ["--depth" as string]: props.depth }}>
      {props.children}
    </li>
  );
}

function Status<T>(props: { load: Load<T> | undefined; depth: number; empty: string; onRetry: () => void }) {
  const load = props.load;
  if (!load || load.state === "loading") return <Note depth={props.depth}>Loading…</Note>;
  if (load.state === "error") {
    return (
      <Note depth={props.depth} error>
        {load.error}{" "}
        <button className="link" onClick={props.onRetry}>
          Retry
        </button>
      </Note>
    );
  }
  if (load.state === "ready" && load.items.length === 0) return <Note depth={props.depth}>{props.empty}</Note>;
  return null;
}

// ---------- One catalog ----------

/** Schemas, tables and columns of one catalog, loaded as they are opened. */
function CatalogBrowser(props: {
  profile: string;
  catalog: string;
  filter: string;
  collapseSignal: number;
  onInsert: (text: string) => void;
}) {
  const { profile, catalog, filter } = props;
  const [schemas, setSchemas] = useState<Load<string>>(loading);
  const [tables, setTables] = useState<Record<string, Load<TableRef>>>({});
  const [columns, setColumns] = useState<Record<string, Load<Column>>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());

  const loadSchemas = useCallback(() => {
    let live = true;
    setSchemas(loading);
    SQLService.ListSchemas(profile, catalog)
      .then((items) => live && setSchemas({ state: "ready", items: items ?? [], error: "" }))
      .catch((e) => live && setSchemas({ state: "error", items: [], error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [profile, catalog]);

  useEffect(loadSchemas, [loadSchemas]);
  useEffect(() => setOpen(new Set()), [props.collapseSignal]);

  const loadTables = (schema: string) => {
    setTables((t) => ({ ...t, [schema]: loading }));
    SQLService.ListTables(profile, catalog, schema)
      .then((items) => setTables((t) => ({ ...t, [schema]: { state: "ready", items: items ?? [], error: "" } })))
      .catch((e) => setTables((t) => ({ ...t, [schema]: { state: "error", items: [], error: errorText(e) } })));
  };

  const loadColumns = (full: string) => {
    setColumns((c) => ({ ...c, [full]: loading }));
    SQLService.TableColumns(profile, full)
      .then((items) => setColumns((c) => ({ ...c, [full]: { state: "ready", items: items ?? [], error: "" } })))
      .catch((e) => setColumns((c) => ({ ...c, [full]: { state: "error", items: [], error: errorText(e) } })));
  };

  const toggle = (key: string, load: Load<unknown> | undefined, fetch: () => void) => {
    const next = new Set(open);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      if (!load || load.state === "error") fetch();
    }
    setOpen(next);
  };

  const q = filter.trim();
  const rows = schemas.items.flatMap((schema) => {
    const tl = tables[schema];
    const schemaHit = matches(schema, q);
    const tableHits = tl?.items.filter((t) => matches(t.name, q)) ?? [];
    if (!schemaHit && tableHits.length === 0) return [];
    // A schema shown only because some of its tables match opens to show them.
    const forced = q !== "" && !schemaHit;
    return [{ schema, tl, open: open.has(schema) || forced, list: forced ? tableHits : (tl?.items ?? []) }];
  });
  const unsearched = q !== "" && schemas.items.some((s) => tables[s]?.state !== "ready");

  return (
    <ul className="tree" role="tree" aria-label={`Schemas in ${catalog}`}>
      {schemas.state !== "ready" ? (
        <Status load={schemas} depth={0} empty="" onRetry={loadSchemas} />
      ) : schemas.items.length === 0 ? (
        <Note depth={0}>No schemas you can see in this catalog.</Note>
      ) : rows.length === 0 ? (
        <Note depth={0}>Nothing matches “{q}”.</Note>
      ) : null}
      {rows.map(({ schema, tl, open: isOpen, list }) => (
        <Row
          key={schema}
          depth={0}
          icon="schema"
          label={schema}
          open={isOpen}
          onToggle={() => toggle(schema, tl, () => loadTables(schema))}
          onInsert={() => props.onInsert(qualified(catalog, schema))}
          insertText={`${catalog}.${schema}`}
        >
          <Status load={tl} depth={1} empty="No tables." onRetry={() => loadTables(schema)} />
          {list.map((t) => {
            const full = [catalog, schema, t.name].join(".");
            const cl = columns[full];
            const isView = t.type === "VIEW" || t.type === "MATERIALIZED_VIEW";
            return (
              <Row
                key={t.name}
                depth={1}
                icon={isView ? "view" : "table"}
                label={t.name}
                hint={t.type === "MATERIALIZED_VIEW" ? "mat. view" : isView ? "view" : undefined}
                open={open.has(full)}
                onToggle={() => toggle(full, cl, () => loadColumns(full))}
                onInsert={() => props.onInsert(qualified(catalog, schema, t.name))}
                insertText={full}
              >
                <Status load={cl} depth={2} empty="No columns." onRetry={() => loadColumns(full)} />
                {cl?.items.map((c) => (
                  <Row
                    key={c.name}
                    depth={2}
                    icon="column"
                    label={c.name}
                    hint={c.type}
                    onInsert={() => props.onInsert(quoteIdent(c.name))}
                  />
                ))}
              </Row>
            );
          })}
        </Row>
      ))}
      {unsearched && rows.length > 0 && (
        <Note depth={0}>Tables are searched only in schemas you have opened.</Note>
      )}
    </ul>
  );
}

// ---------- Choosing catalogs ----------

function CatalogPicker(props: {
  all: string[];
  visible: string[];
  onCancel: () => void;
  onSave: (visible: string[]) => Promise<void>;
}) {
  const [some, setSome] = useState(props.visible.length > 0);
  const [ticked, setTicked] = useState<Set<string>>(new Set(props.visible));
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Saved catalogs that no longer exist stay listed so they can be unticked.
  const names = useMemo(() => {
    const missing = props.visible.filter((v) => !props.all.includes(v));
    return [...props.all, ...missing];
  }, [props.all, props.visible]);
  const listed = names.filter((n) => matches(n, search));

  const flip = (name: string) => {
    const next = new Set(ticked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setTicked(next);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await props.onSave(some ? names.filter((n) => ticked.has(n)) : []);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="cat-picker">
      <div className="cat-picker-head">
        <strong>Catalogs to show</strong>
        <span className="muted">Saved for this workspace.</span>
      </div>
      <div className="cat-mode" role="radiogroup" aria-label="Catalogs to show">
        <label>
          <input type="radio" name="cat-mode" checked={!some} onChange={() => setSome(false)} />
          All catalogs
        </label>
        <label>
          <input type="radio" name="cat-mode" checked={some} onChange={() => setSome(true)} />
          Only these
        </label>
      </div>
      {some && (
        <>
          <div className="cat-picker-tools">
            <input
              className="input small"
              type="search"
              placeholder="Find a catalog"
              aria-label="Find a catalog"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="cat-picker-meta">
            <span className="muted">{ticked.size} selected</span>
            <span>
              <button className="link" onClick={() => setTicked(new Set([...ticked, ...listed]))}>
                Select {search ? "matches" : "all"}
              </button>{" "}
              ·{" "}
              <button className="link" onClick={() => setTicked(new Set())}>
                Clear
              </button>
            </span>
          </div>
          <ul className="cat-list">
            {listed.map((n) => (
              <li key={n}>
                <label title={n}>
                  <input type="checkbox" checked={ticked.has(n)} onChange={() => flip(n)} />
                  <Icon kind="catalog" className="kind-catalog" />
                  <span className="tree-name">{n}</span>
                  {!props.all.includes(n) && <span className="tree-hint">not found</span>}
                </label>
              </li>
            ))}
            {listed.length === 0 && <li className="tree-note">No catalog matches “{search}”.</li>}
          </ul>
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="cat-picker-foot">
        <button className="btn small" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn small primary" onClick={save} disabled={busy || (some && ticked.size === 0)}>
          Save
        </button>
      </div>
    </div>
  );
}

// ---------- Panel ----------

/** Unity Catalog browser: one catalog at a time, limited to the catalogs chosen for this workspace. */
export function CatalogTree(props: { profile: string; onInsert: (text: string) => void }) {
  const { profile } = props;
  const [all, setAll] = useState<Load<string>>(idle);
  const [prefs, setPrefs] = useState<Prefs>({ visible: [], current: "" });
  const [epoch, setEpoch] = useState(0);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const [collapseSignal, setCollapseSignal] = useState(0);

  useEffect(() => {
    let live = true;
    setAll(loading);
    const saved = SQLService.CatalogPrefs(profile).catch(() => ({ visible: [], current: "" }));
    Promise.all([SQLService.ListCatalogs(profile), saved])
      .then(([items, p]) => {
        if (!live) return;
        setPrefs({ visible: p.visible ?? [], current: p.current ?? "" });
        setAll({ state: "ready", items: items ?? [], error: "" });
      })
      .catch((e) => live && setAll({ state: "error", items: [], error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [profile, epoch]);

  const shown = shownCatalogs(all.items, prefs.visible);
  const current = pickCurrent(shown, prefs.current);
  const limited = prefs.visible.length > 0;

  const save = (next: Prefs) => {
    setPrefs(next);
    return SQLService.SaveCatalogPrefs(profile, next);
  };

  // A filter typed for one catalog means nothing in the next.
  useEffect(() => setFilter(""), [current]);

  const choose = (catalog: string) => {
    save({ ...prefs, current: catalog }).catch(() => {});
  };

  if (picking && all.state === "ready") {
    return (
      <div className="side-body">
        <CatalogPicker
          all={all.items}
          visible={prefs.visible}
          onCancel={() => setPicking(false)}
          onSave={async (visible) => {
            await save({ ...prefs, visible });
            setPicking(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="side-body cat">
      <div className="cat-head">
        <div className="cat-row">
          <label className="cat-select">
            <Icon kind="catalog" className="kind-catalog" />
            <select
              aria-label="Catalog"
              value={current}
              onChange={(e) => choose(e.target.value)}
              disabled={shown.length === 0}
            >
              {shown.length === 0 && <option value="">{all.state === "loading" ? "Loading…" : "No catalogs"}</option>}
              {shown.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button
            className={limited ? "icon-btn on" : "icon-btn"}
            aria-label="Choose which catalogs to show"
            title={
              limited
                ? `Showing ${shown.length} of ${all.items.length} catalogs. Choose which to show.`
                : "Choose which catalogs to show"
            }
            onClick={() => setPicking(true)}
            disabled={all.state !== "ready"}
          >
            <Icon kind="funnel" />
          </button>
        </div>
        <div className="cat-row">
          <input
            className="input small"
            type="search"
            placeholder="Filter schemas and tables"
            aria-label="Filter schemas and tables"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            disabled={!current}
          />
          <button
            className="icon-btn"
            aria-label="Collapse all"
            title="Collapse all"
            onClick={() => setCollapseSignal((n) => n + 1)}
            disabled={!current}
          >
            <Icon kind="collapse" />
          </button>
          <button className="icon-btn" aria-label="Reload" title="Reload" onClick={() => setEpoch((n) => n + 1)}>
            <Icon kind="reload" />
          </button>
        </div>
      </div>
      {all.state === "error" ? (
        <ul className="tree">
          <Status load={all} depth={0} empty="" onRetry={() => setEpoch((n) => n + 1)} />
        </ul>
      ) : all.state === "ready" && all.items.length === 0 ? (
        <ul className="tree">
          <Note depth={0}>No catalogs you can see in this workspace.</Note>
        </ul>
      ) : all.state === "ready" && shown.length === 0 ? (
        <ul className="tree">
          <Note depth={0}>
            None of the catalogs chosen for this workspace exist.{" "}
            <button className="link" onClick={() => setPicking(true)}>
              Choose catalogs
            </button>
          </Note>
        </ul>
      ) : current ? (
        <CatalogBrowser
          key={`${epoch}:${current}`}
          profile={profile}
          catalog={current}
          filter={filter}
          collapseSignal={collapseSignal}
          onInsert={props.onInsert}
        />
      ) : null}
      {current && <p className="cat-tip muted">Click a column, or the insert arrow on a row, to add its name.</p>}
    </div>
  );
}
