import { useCallback, useEffect, useRef, useState } from "react";
import { WorkspaceService, type Overview as OverviewData, type Workspace } from "../bindings/dbx-desktop";
import { displayName, errorText, openExternal, relativeTime, stateLabel } from "./lib";

const REFRESH_MS = 60_000;

export function Overview(props: { workspace: Workspace; onSignIn: (ws: Workspace) => void; authEpoch: number }) {
  const ws = props.workspace;
  const profile = ws.profile.name;
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0);
  const current = useRef(profile);
  current.current = profile;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const o = await WorkspaceService.Overview(profile);
      // Ignore a response for a workspace the user has already left.
      if (current.current !== profile) return;
      setData(o);
      setError("");
    } catch (e) {
      if (current.current !== profile) return;
      setError(errorText(e));
    } finally {
      if (current.current === profile) setLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    setData(null);
    setError("");
    load();
    const refresh = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      clearInterval(refresh);
      clearInterval(clock);
    };
  }, [load, props.authEpoch]);

  const failed = data?.failedRuns ?? [];
  const warehouses = data?.warehouses ?? [];
  const running = warehouses.filter((w) => w.state === "RUNNING").length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{displayName(ws)}</h1>
          <p className="muted">
            {data?.user ? `Signed in as ${data.user}` : loading ? "Connecting…" : " "}
          </p>
        </div>
        <div className="row">
          {data && <span className="muted">Updated {relativeTime(data.fetchedAt)}</span>}
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn" onClick={() => openExternal(ws.profile.host)}>
            Open in Databricks
          </button>
        </div>
      </div>

      {error && (
        <div className="notice error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {data?.authError && (
        <div className="notice error" role="alert">
          <div>
            <strong>Could not connect to this workspace</strong>
            <div className="muted">{data.authError}</div>
          </div>
          {ws.profile.authType === "databricks-cli" && (
            <button className="btn primary" onClick={() => props.onSignIn(ws)}>
              Sign in again
            </button>
          )}
        </div>
      )}

      {data && !data.authError && (
        <div className="grid-2">
          <section className="card" aria-labelledby="failed-h">
            <div className="card-head">
              <h2 id="failed-h">Failed runs, past 24 hours</h2>
              <span className={failed.length ? "badge prod" : "badge ok"}>{failed.length}</span>
            </div>
            {data.runsError ? (
              <div className="empty inline-error">{data.runsError}</div>
            ) : failed.length === 0 ? (
              <div className="empty">
                No failed runs.{" "}
                {data.runsChecked > 0
                  ? `${data.runsChecked} completed ${data.runsChecked === 1 ? "run" : "runs"} checked.`
                  : "No runs completed in this period."}
              </div>
            ) : (
              <ul className="list">
                {failed.map((r) => (
                  <li key={r.runId}>
                    <div className="grow">
                      <div className="title">{r.name}</div>
                      <div className="sub" title={r.message}>
                        {stateLabel(r.state)} · {relativeTime(r.endTime)}
                        {r.message ? ` · ${r.message}` : ""}
                      </div>
                    </div>
                    {r.url && (
                      <button className="btn small" onClick={() => openExternal(r.url)}>
                        Open
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.runsTruncated && (
              <div className="card-body muted">Only the most recent {data.runsChecked} runs were checked.</div>
            )}
          </section>

          <section className="card" aria-labelledby="wh-h">
            <div className="card-head">
              <h2 id="wh-h">SQL warehouses</h2>
              <span className={running ? "badge warn" : "badge"}>{running} running</span>
            </div>
            {data.warehousesError ? (
              <div className="empty inline-error">{data.warehousesError}</div>
            ) : warehouses.length === 0 ? (
              <div className="empty">No SQL warehouses in this workspace.</div>
            ) : (
              <ul className="list">
                {warehouses.map((w) => (
                  <li key={w.id}>
                    <div className="grow">
                      <div className="title">{w.name}</div>
                      <div className="sub">
                        {[w.size, w.serverless ? "Serverless" : ""].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className={w.state === "RUNNING" ? "badge warn" : "badge"}>{stateLabel(w.state)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
