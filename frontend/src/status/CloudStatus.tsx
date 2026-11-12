import { useState } from "react";
import { openExternal, relativeTime } from "../lib";
import { labels, providerNames, providerUnavailable, regionHealth, watchSummary } from "./health";
import type { CloudStatusState } from "./useCloudStatus";
import "./status.css";

export function HealthDot({ health }: { health: string }) {
  return <span className={`health-dot health-${health}`} aria-hidden="true" />;
}

export function CloudStatusIndicator({ state, active, onOpen }: { state: CloudStatusState; active: boolean; onOpen: () => void }) {
  const summary = watchSummary(state.providers, state.watch, state.now);
  const unavailable = !state.ready || !!state.error;
  const text = state.watchError && !state.ready ? "Could not load watched regions"
    : !state.ready ? "Loading watched regions…" : state.error ? "Status unavailable" : summary.text;
  return (
    <button className="rail-item cloud-indicator" aria-current={active ? "page" : undefined} onClick={onOpen} title={text}>
      <HealthDot health={unavailable ? "unknown" : summary.health} />
      <span className="cloud-indicator-copy"><span>Cloud status</span><small aria-live="polite">{text}</small></span>
    </button>
  );
}

export function CloudStatus({ state }: { state: CloudStatusState }) {
  const [providerID, setProviderID] = useState("aws");
  const [inspected, setInspected] = useState("");
  const [filter, setFilter] = useState("");
  const summary = watchSummary(state.providers, state.watch, state.now);
  const provider = state.providers.find((p) => p.id === providerID);
  const regions = provider?.regions ?? [];
  const watched = state.watch[providerID] ?? [];
  const region = regions.find((r) => r.id === inspected) ?? regions.find((r) => watched.includes(r.id)) ?? regions[0];
  const unavailable = !!state.error || providerUnavailable(provider, state.now);
  const filtered = regions.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));
  const missing = watched.filter((id) => !regions.some((r) => r.id === id));
  const disabled = state.saving || !state.ready;
  const chooseProvider = (id: string) => { setProviderID(id); setInspected(""); setFilter(""); };
  const toggle = (id: string) => state.save(providerID, watched.includes(id) ? watched.filter((v) => v !== id) : [...watched, id]);

  return (
    <div className="page cloud-status">
      <div className="page-head">
        <div><h1>Databricks cloud status</h1><p className="muted">Watch regions across AWS, Azure and GCP. Your choices apply throughout the app.</p></div>
        <button className="btn" disabled={state.loading} onClick={() => state.refresh(true)}>{state.loading ? "Checking…" : "Refresh status"}</button>
      </div>

      {state.watchError && <div className="notice error" role="alert"><span>Could not load or save watched regions. {state.watchError}</span><button className="btn small" onClick={state.loadWatch}>Reload choices</button></div>}

      <section className="watch-summary" aria-label="Watched region status">
        <div className="row" role="status"><HealthDot health={state.error || !state.ready ? "unknown" : summary.health} /><strong>{!state.ready ? state.watchError ? "Watched regions unavailable" : "Loading watched regions…" : state.error ? "Status unavailable" : summary.text}</strong><span className="muted">{summary.items.length} watched</span></div>
        {summary.items.length > 0 ? <div className="watched-regions">{summary.items.map((item) => (
          <button className="watched-region" key={`${item.providerID}:${item.id}`} onClick={() => { chooseProvider(item.providerID); setInspected(item.id); }}>
            <HealthDot health={state.error ? "unknown" : item.health} /><span>{item.providerName} · {item.name}</span><span className="muted">{labels[state.error ? "unknown" : item.health]}</span>
          </button>
        ))}</div> : <p className="muted">Choose a provider below, then check the regions you want to watch. The sidebar shows their combined health.</p>}
      </section>

      <div className="cloud-controls">
        <label className="row">Cloud provider <select aria-label="Cloud provider" className="input select" value={providerID} onChange={(e) => chooseProvider(e.target.value)}>{Object.entries(providerNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <div className="row"><span className="muted">{provider?.fetchedAt ? `Checked ${relativeTime(provider.fetchedAt, state.now)}` : "Not checked yet"}</span>{provider && <button className="link" onClick={() => openExternal(provider.url)}>Open official status page</button>}</div>
      </div>
      {unavailable && <div className="notice" role="status"><span>{provider?.error || state.error || (state.loading ? `Loading ${providerNames[providerID]} status…` : "Current status is unavailable. Try refreshing or open the official status page.")}{provider?.fetchedAt ? " The details below are from the last successful check." : ""}</span></div>}

      <div className="cloud-columns">
        <section className="cloud-region-picker" aria-labelledby="regions-heading">
          <div className="cloud-section-head"><h2 id="regions-heading">{providerNames[providerID]} regions</h2><span className="muted">{watched.length} watched</span></div>
          <input className="input" aria-label="Filter regions" placeholder="Filter regions" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="row cloud-selection-actions"><button className="link" disabled={disabled || !regions.length} onClick={() => state.save(providerID, [...new Set([...watched, ...regions.map((r) => r.id)])])}>Watch all</button><button className="link" disabled={disabled || !watched.length} onClick={() => state.save(providerID, [])}>Clear</button></div>
          <ul className="cloud-region-list">
            {filtered.map((r) => <li key={r.id} className={region?.id === r.id ? "inspected" : ""}>
              <input type="checkbox" aria-label={`Watch ${providerNames[providerID]} ${r.name}`} checked={watched.includes(r.id)} disabled={disabled} onChange={() => toggle(r.id)} />
              <button aria-pressed={region?.id === r.id} onClick={() => setInspected(r.id)}><span>{r.name}</span><HealthDot health={unavailable ? "unknown" : regionHealth(provider, r.id, state.now)} /><span className="sr-only">{labels[unavailable ? "unknown" : r.health]}</span></button>
            </li>)}
          </ul>
          {!filtered.length && <p className="empty">{regions.length ? "No regions match your filter." : state.loading ? "Loading regions…" : "No regions available. Refresh to try again."}</p>}
          {missing.map((id) => <div className="cloud-missing" key={id}><span>Watched region unavailable</span><button className="link" disabled={disabled} onClick={() => toggle(id)}>Remove</button></div>)}
        </section>

        <section className="cloud-region-detail" aria-label="Regional service status">
          {region ? <>
            <div className="cloud-section-head"><h2>{region.name}</h2><span className="row"><HealthDot health={unavailable ? "unknown" : region.health} />{labels[unavailable ? "unknown" : region.health]}</span></div>
            <p className="muted">{watched.includes(region.id) ? "Watching this region." : "Check this region to include it in the sidebar indicator."}</p>
            {(region.events ?? []).length > 0 && <div className="cloud-events">{region.events?.map((event, i) => <div key={i} className="cloud-event"><strong>{event.kind === "upcoming" ? "Scheduled maintenance" : event.kind === "maintenance" ? "Active maintenance" : "Active incident"}</strong><p>{event.name}</p>{event.startsAt && <p className="muted">{eventTime(event.startsAt)}{event.endsAt ? ` to ${eventTime(event.endsAt)}` : ""}</p>}</div>)}</div>}
            <ul className="cloud-service-list">{region.services?.map((service) => <li key={service.name}><span>{service.name}</span><span className="row"><HealthDot health={unavailable ? "unknown" : service.health} /><span>{unavailable ? "Status unavailable" : service.status || labels[service.health]}</span></span></li>)}</ul>
          </> : <div className="empty">Select a region to see its Databricks services.</div>}
        </section>
      </div>
      <p className="muted cloud-footnote">Status comes from Databricks' public status pages and refreshes every 5 minutes. Green means every reported service in your watched regions is operational. Unavailable or outdated feeds appear gray.</p>
    </div>
  );
}

function eventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
