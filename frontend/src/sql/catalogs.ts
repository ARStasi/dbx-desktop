// Pure helpers for the catalog browser.

/** The catalogs to offer, given every catalog and the saved selection. An empty selection means all. */
export function shownCatalogs(all: string[], visible: string[]): string[] {
  if (visible.length === 0) return all;
  const want = new Set(visible);
  return all.filter((c) => want.has(c));
}

/** The catalog to open: the saved one if it is still offered, else a sensible default. */
export function pickCurrent(shown: string[], saved: string): string {
  if (saved && shown.includes(saved)) return saved;
  if (shown.includes("main")) return "main";
  return shown.find((c) => c !== "system" && !c.startsWith("__")) ?? shown[0] ?? "";
}

/** Case-insensitive substring match. An empty query matches everything. */
export function matches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}
