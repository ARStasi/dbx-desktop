import { useEffect, useState } from "react";
import { DesktopService, type DesktopState } from "../bindings/dbx-desktop";
import { errorText } from "./lib";

export function DesktopSettings() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = () => DesktopService.State().then(setState);
  useEffect(() => { reload().catch((e) => setError(errorText(e))); }, []);

  const change = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (e) { setError(errorText(e)); }
    finally {
      try { await reload(); } catch (e) { setError(errorText(e)); }
      setBusy(false);
    }
  };

  return (
    <div className="page desktop-settings">
      <div className="page-head">
        <div><h1>Settings</h1><p className="muted">Desktop behavior for all workspaces.</p></div>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!state ? <p role="status">{error ? "Settings could not be loaded." : "Loading settings…"}</p> : <>
        <fieldset disabled={busy}>
          <legend>Window</legend>
          <label className="desktop-option">
            <input type="checkbox" checked={state.preferences.keepInTray}
              onChange={(e) => change(() => DesktopService.SetKeepInTray(e.target.checked))} />
            <span><strong>Keep running in system tray when closed</strong>
              <span className="muted">Closing the window keeps queries and notebook runs going. Open it again from the system tray or macOS menu bar. Choose Quit there to exit.</span>
            </span>
          </label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Notifications</legend>
          <label className="desktop-option">
            <input type="checkbox" checked={state.preferences.notifications}
              disabled={!state.notificationsAvailable && !state.preferences.notifications}
              onChange={(e) => change(() => DesktopService.SetNotifications(e.target.checked))} />
            <span><strong>Notify when queries and notebook runs finish</strong>
              <span className="muted">Get a desktop notification when a run succeeds or fails while this app is in the background. Run all sends one notification; cancelled runs stay silent.</span>
            </span>
          </label>
          {!state.notificationsAvailable ? <p className="muted">Notifications are unavailable here. Use the packaged desktop app.</p>
            : state.preferences.notifications && !state.notificationsAllowed ?
              <div className="notice" role="status">
                <span>System permission is off. Allow dbx-desktop in your system notification settings, then check again.</span>
                <button className="btn small" onClick={() => change(() => DesktopService.SetNotifications(true))}>Check permission</button>
              </div> : null}
          {state.notificationError && <p className="notice error" role="status">{state.notificationError}</p>}
          <div className="row">
            <button className="btn" disabled={!state.preferences.notifications || !state.notificationsAllowed}
              onClick={() => change(async () => { await DesktopService.TestNotification(); setNotice("Test notification sent. Your system's notification and Focus settings control whether it appears."); })}>
              Send test notification
            </button>
            {busy && <span className="muted" role="status">Saving…</span>}
          </div>
          {notice && <p className="muted" role="status">{notice}</p>}
        </fieldset>
      </>}
    </div>
  );
}
