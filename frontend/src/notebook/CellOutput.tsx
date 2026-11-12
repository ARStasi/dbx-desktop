import { useEffect, useState } from "react";
import type { CellRun } from "../../bindings/dbx-desktop";
import { ResultsGrid } from "../sql/ResultsGrid";

/** A cell run the view is tracking. */
export interface CellRunState {
  runId: string;
  /** queued: waiting for an earlier cell; running; or done with a result. */
  phase: "queued" | "running" | "done";
  startedAt: number;
  /** The cluster the run was sent to, so old output says where it came from. */
  clusterName: string;
  result?: CellRun;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function Elapsed(props: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  return <>{Math.floor((Date.now() - props.since) / 1000)} s</>;
}

const GRID_MAX = 360;

/** What a cell produced, under its editor. */
export function CellOutput(props: { run: CellRunState; onCancel: () => void }) {
  const { run } = props;
  if (run.phase === "queued") {
    return (
      <div className="cell-out cell-meta">
        <span className="muted">Waiting for the cells above…</span>
        <button className="link" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    );
  }
  if (run.phase === "running") {
    return (
      <div className="cell-out cell-meta">
        <span className="spinner" aria-hidden="true" />
        <span>
          Running on {run.clusterName} · <Elapsed since={run.startedAt} />
        </span>
        <button className="link" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    );
  }
  const res = run.result;
  if (!res) return null;
  const out = res.output;
  const rows = out.rows ?? [];
  const cols = out.columns ?? [];
  const meta = (
    <div className="cell-meta">
      <span className={out.status === "finished" ? "ok-text" : out.status === "cancelled" ? "muted" : "bad-text"}>
        {out.status === "finished"
          ? "Done"
          : out.status === "cancelled"
            ? "Cancelled"
            : out.status === "error"
              ? "Error"
              : "Not run"}
      </span>
      {out.durationMs > 0 && <span className="muted">{seconds(out.durationMs)}</span>}
      {run.clusterName && out.status !== "failed" && <span className="muted">on {run.clusterName}</span>}
      {res.started && out.status !== "failed" && (
        <span className="badge" title="Variables from cells run before this one are not defined.">
          New session
        </span>
      )}
    </div>
  );
  return (
    <div className="cell-out" aria-live="polite">
      {out.status === "error" && (
        <div className="cell-error" role="alert">
          <strong>{out.error}</strong>
          {out.detail && out.detail.trim() !== out.error && (
            <details>
              <summary>Traceback</summary>
              <pre>{out.detail}</pre>
            </details>
          )}
        </div>
      )}
      {out.status === "failed" && (
        <div className="cell-error" role="alert">
          <strong>{out.error}</strong>
          {out.detail && out.detail.trim() !== out.error && (
            <details>
              <summary>Details</summary>
              <pre>{out.detail}</pre>
            </details>
          )}
        </div>
      )}
      {out.status === "cancelled" && out.error && <div className="cell-note">{out.error}</div>}
      {out.text && <pre className="cell-text">{out.text}</pre>}
      {out.kind === "table" && (
        <>
          {cols.length > 0 ? (
            <div className="cell-grid" style={{ height: Math.min(GRID_MAX, 32 + Math.max(rows.length, 1) * 26 + 14) }}>
              <ResultsGrid columns={cols} rows={rows} />
            </div>
          ) : (
            <div className="cell-note">The result has no columns.</div>
          )}
          <div className="cell-note">
            {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
            {out.truncated && " · only the first rows were returned"}
          </div>
        </>
      )}
      {out.kind === "image" && (
        <div className="cell-images">
          {(out.images ?? []).map((src, i) => (
            <img key={i} src={src} alt={`Plot ${i + 1}`} />
          ))}
          {(out.imageNotes ?? []).map((n, i) => (
            <div key={i} className="cell-note">
              {n}
            </div>
          ))}
        </div>
      )}
      {meta}
    </div>
  );
}
