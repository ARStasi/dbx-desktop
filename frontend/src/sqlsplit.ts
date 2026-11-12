// Splits editor text into SQL statements and judges how risky one is to run.
// The Statement Execution API runs one statement per call, so the scratchpad
// runs the statement under the cursor.

/** Offsets into the text; the statement is text.slice(start, end), without its semicolon. */
export interface Span {
  start: number;
  end: number;
}

interface Segment extends Span {
  /** True when the segment holds only whitespace and comments. */
  empty: boolean;
}

/** Splits on semicolons that are outside strings, quoted names and comments. */
function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  let hasCode = false;
  let i = 0;
  const n = text.length;

  const push = (end: number) => {
    out.push({ start, end, empty: !hasCode });
    start = end + 1;
    hasCode = false;
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      hasCode = true;
      i++;
      while (i < n) {
        if (text[i] === "\\" && c !== "`") {
          i += 2;
        } else if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2; // a doubled quote is an escaped quote
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
    } else if (c === ";") {
      push(i);
      i++;
    } else {
      if (!/\s/.test(c)) hasCode = true;
      i++;
    }
  }
  push(n);
  return out;
}

/** The statements in the text, skipping empty ones. */
export function splitStatements(text: string): Span[] {
  return segments(text)
    .filter((s) => !s.empty)
    .map(({ start, end }) => ({ start, end }));
}

/**
 * The statement the cursor is in, trimmed. A cursor just after a semicolon on
 * the same line, or in a gap between statements, picks the statement before it.
 */
export function statementAt(text: string, cursor: number): string {
  const segs = segments(text);
  let idx = segs.findIndex((s) => cursor <= s.end);
  if (idx === -1) idx = segs.length - 1;
  // A cursor sitting just after a semicolon, still on its line, belongs to
  // the statement that semicolon ends.
  if (idx > 0 && /^[^\S\n]*$/.test(text.slice(segs[idx - 1].end + 1, cursor))) idx--;
  let pick = idx;
  while (pick >= 0 && segs[pick].empty) pick--;
  if (pick < 0) {
    pick = idx;
    while (pick < segs.length && segs[pick].empty) pick++;
  }
  if (pick < 0 || pick >= segs.length) return "";
  return text.slice(segs[pick].start, segs[pick].end).trim();
}

export type Risk = "read" | "write" | "destructive";

const READ_ONLY = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "FROM", "LIST", "USE", "SET"]);
const DESTRUCTIVE = new Set(["DROP", "TRUNCATE", "DELETE"]);

/** Removes leading whitespace, comments and opening parentheses. */
function stripLead(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.replace(/^[\s(]+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const close = s.indexOf("*/");
      s = close === -1 ? "" : s.slice(close + 2);
    } else {
      return s;
    }
  }
}

/**
 * Judges a statement by its leading keyword. "read" changes nothing, "write"
 * changes data or objects, and "destructive" removes or replaces them.
 * Anything unrecognized counts as "write", so the guess errs toward asking.
 */
export function classify(statement: string): Risk {
  const s = stripLead(statement).toUpperCase();
  const word = s.match(/^[A-Z_]+/)?.[0] ?? "";
  if (word === "") return "read";
  if (READ_ONLY.has(word)) return "read";
  if (DESTRUCTIVE.has(word)) return "destructive";
  if (/^CREATE\s+OR\s+REPLACE\b/.test(s)) return "destructive";
  if (/^INSERT\s+OVERWRITE\b/.test(s)) return "destructive";
  return "write";
}

/**
 * Whether to ask before running. Production workspaces ask for anything that
 * is not read-only; others ask only for destructive statements.
 */
export function needsConfirm(risk: Risk, prod: boolean): boolean {
  return prod ? risk !== "read" : risk === "destructive";
}
