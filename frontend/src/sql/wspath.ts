/** One step of a workspace folder path, for breadcrumbs. */
export interface Crumb {
  name: string;
  path: string;
}

/** Breadcrumbs for a workspace folder, starting with the root as "Workspace". */
export function crumbs(folder: string): Crumb[] {
  const out: Crumb[] = [{ name: "Workspace", path: "/" }];
  let path = "";
  for (const part of folder.split("/")) {
    if (!part) continue;
    path += "/" + part;
    out.push({ name: part, path });
  }
  return out;
}

/** The file name a typed name is saved as: trimmed, with .sql added when missing. Empty if unusable. */
export function sqlName(name: string): string {
  const n = name.trim();
  if (!n || n === "." || n === ".." || /[/\\]/.test(n)) return "";
  return /\.sql$/i.test(n) ? n : `${n}.sql`;
}

/** The name suggested when saving a scratch query: its file name without .sql, or empty for Untitled-N. */
export function suggestedName(fileName: string): string {
  const base = fileName.replace(/\.sql$/i, "");
  return /^Untitled-\d+$/.test(base) ? "" : base;
}
