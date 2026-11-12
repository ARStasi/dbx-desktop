// CSV export and identifier quoting for the SQL scratchpad.

type Row = (string | null)[] | null;

function field(value: string | null): string {
  if (value === null) return "";
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 CSV with a header row. SQL NULL becomes an empty field. */
export function toCSV(columns: { name: string }[], rows: Row[]): string {
  const lines = [columns.map((c) => field(c.name)).join(",")];
  for (const row of rows) {
    lines.push((row ?? []).map(field).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Quotes a name with backticks unless it is a plain identifier. */
export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "`" + name.replace(/`/g, "``") + "`";
}

/** Joins name parts into a dotted, safely quoted reference. */
export function qualified(...parts: string[]): string {
  return parts.map(quoteIdent).join(".");
}
