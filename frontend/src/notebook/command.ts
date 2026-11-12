import { splitStatements } from "../sqlsplit.ts";

/** What running a cell means. */
export type CellPlan =
  | { kind: "python"; code: string }
  /** A %sql cell, run through spark.sql in the same Python session. */
  | { kind: "sql"; code: string; statements: string[] }
  /** A %md cell is rendered, not run. */
  | { kind: "markdown"; text: string }
  /** A %pip install cell; it runs only where packages can be installed. */
  | { kind: "pip"; args: string }
  | { kind: "empty" }
  | { kind: "unsupported"; magic: string; reason: string };

export type CellLanguage = "python" | "sql" | "markdown" | "other";

/** The magic on a cell's first line, such as "sql", or "" for Python. */
export function magicOf(source: string): string {
  const m = /^\s*%([A-Za-z][\w-]*)/.exec(source);
  return m ? m[1].toLowerCase() : "";
}

export function languageOf(source: string): CellLanguage {
  switch (magicOf(source)) {
    case "":
    case "python":
      return "python";
    case "sql":
      return "sql";
    case "md":
    case "md-sandbox":
      return "markdown";
    default:
      return "other";
  }
}

/**
 * The cell's text without its magic. Text after the magic on the same line,
 * as in "%md ## Title", is kept as the first line.
 */
export function body(source: string): string {
  const m = /^\s*%[A-Za-z][\w-]*[ \t]*/.exec(source);
  const rest = m ? source.slice(m[0].length) : source;
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

const REASONS: Record<string, string> = {
  pip: "%pip runs only with serverless compute here, where it installs into this computer's Python environment. On a cluster, install the library on the cluster instead.",
  sh: "Shell cells are not supported here. Use subprocess from Python instead.",
  fs: "Use dbutils.fs from a Python cell instead.",
  run: "%run is not supported here. Import the code as a module instead.",
  scala: "Only Python and SQL cells run in this app.",
  r: "Only Python and SQL cells run in this app.",
};

/**
 * Builds Python that runs SQL statements with spark.sql in the notebook's
 * session, so temporary views and settings are shared with Python cells.
 * Every statement but the last runs for its effect; the last one's result is
 * displayed. JSON string literals are valid Python string literals.
 */
export function sqlToPython(statements: string[]): string {
  const list = statements.map((s) => `    ${JSON.stringify(s)},`).join("\n");
  return [
    "__dbx_sql = [",
    list,
    "]",
    "for __dbx_stmt in __dbx_sql[:-1]:",
    "    spark.sql(__dbx_stmt)",
    "display(spark.sql(__dbx_sql[-1]))",
  ].join("\n");
}

export function planCell(source: string): CellPlan {
  const magic = magicOf(source);
  switch (magic) {
    case "":
      return source.trim() ? { kind: "python", code: source } : { kind: "empty" };
    case "python": {
      const code = body(source);
      return code.trim() ? { kind: "python", code } : { kind: "empty" };
    }
    case "md":
    case "md-sandbox":
      return { kind: "markdown", text: body(source) };
    case "pip": {
      const words = body(source).trim().split(/\s+/).filter(Boolean);
      if (words[0] !== "install" || words.length < 2) {
        return { kind: "unsupported", magic: "%pip", reason: "Only %pip install <packages> is supported." };
      }
      return { kind: "pip", args: words.slice(1).join(" ") };
    }
    case "sql": {
      const text = body(source);
      const statements = splitStatements(text)
        .map((s) => text.slice(s.start, s.end).trim().replace(/;$/, "").trim())
        .filter(Boolean);
      if (statements.length === 0) return { kind: "empty" };
      return { kind: "sql", code: sqlToPython(statements), statements };
    }
    default:
      return {
        kind: "unsupported",
        magic: `%${magic}`,
        reason: REASONS[magic] ?? `%${magic} cells are not supported here. Only Python and SQL cells run in this app.`,
      };
  }
}
