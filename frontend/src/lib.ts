import { Browser } from "@wailsio/runtime";
import type { Workspace } from "../bindings/dbx-desktop";

/** The name shown for a workspace: its nickname, or the profile name. */
export function displayName(ws: Workspace): string {
  return ws.meta.nickname || ws.profile.name;
}

/** The hostname without the scheme. */
export function shortHost(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Turns anything thrown by a binding call into one readable line. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Opens a link in the system browser, not inside the app window. */
export function openExternal(url: string) {
  Browser.OpenURL(url).catch(() => window.open(url, "_blank", "noopener"));
}

export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function authLabel(authType: string): string {
  switch (authType) {
    case "databricks-cli":
      return "OAuth";
    case "pat":
      return "Token";
    case "oauth-m2m":
      return "Service principal";
    case "unknown":
      return "Unknown";
    default:
      return authType;
  }
}

/** Sentence-case label for an API state such as TIMEDOUT or UPSTREAM_FAILED. */
export function stateLabel(state: string): string {
  const s = state.toLowerCase().replace(/_/g, " ");
  if (s === "timedout") return "Timed out";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
