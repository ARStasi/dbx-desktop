import { useCallback, useEffect, useRef, useState } from "react";
import { CloudStatusService } from "../../bindings/dbx-desktop";
import type { Provider } from "../../bindings/dbx-desktop/internal/cloudstatus/models";
import { errorText } from "../lib";
import type { Watch } from "./health";

export function useCloudStatus() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [watch, setWatch] = useState<Watch>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [watchError, setWatchError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inflight = useRef(false);
  const saveInFlight = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      setProviders((await CloudStatusService.Snapshot(force)) ?? []);
      setError("");
    } catch (e) { setError(errorText(e)); }
    finally { inflight.current = false; setLoading(false); setNow(Date.now()); }
  }, []);

  const loadWatch = useCallback(async () => {
    try {
      const value = (await CloudStatusService.Watch()) ?? {};
      setWatch(Object.fromEntries(Object.entries(value).map(([id, regions]) => [id, regions ?? []])));
      setReady(true);
      setWatchError("");
    } catch (e) { setWatchError(errorText(e)); }
  }, []);

  useEffect(() => {
    refresh();
    loadWatch();
    const timer = window.setInterval(() => { setNow(Date.now()); refresh(); }, 60_000);
    const onFocus = () => { setNow(Date.now()); refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh, loadWatch]);

  const save = async (providerID: string, ids: string[]) => {
    if (!ready || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      const next = { ...watch, [providerID]: ids };
      await CloudStatusService.SaveWatch(next);
      setWatch(next);
      setWatchError("");
    } catch (e) { setWatchError(errorText(e)); }
    finally { saveInFlight.current = false; setSaving(false); }
  };

  return { providers, watch, ready, error, watchError, loading, saving, now, refresh, loadWatch, save };
}

export type CloudStatusState = ReturnType<typeof useCloudStatus>;
