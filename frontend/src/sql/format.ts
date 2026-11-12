// Formats SQL for the scratchpad. sql-formatter's Spark dialect is the closest
// to Databricks SQL, but it splits Databricks operators such as `=>` and does
// not know clauses such as QUALIFY or MERGE, so this extends it.

import { expandPhrases, formatDialect, spark, type DialectOptions } from "sql-formatter";

type Tokens = Parameters<NonNullable<DialectOptions["tokenizerOptions"]["postProcess"]>>[0];

const base = spark.tokenizerOptions;

const clauses = expandPhrases([
  "QUALIFY",
  "WHEN [NOT] MATCHED [BY SOURCE | BY TARGET] [AND]",
  "THEN UPDATE SET",
  "THEN DELETE",
  "THEN INSERT",
  "UPDATE",
  "SET",
  "DELETE FROM",
]);

const onelineClauses = expandPhrases([
  "MERGE INTO",
  "CREATE [OR REPLACE] [TEMPORARY] TABLE [IF NOT EXISTS]",
  "CREATE [OR REPLACE] {MATERIALIZED VIEW | STREAMING TABLE} [IF NOT EXISTS]",
  "CREATE [OR REPLACE] [TEMPORARY] FUNCTION [IF NOT EXISTS]",
  "CREATE {CATALOG | SCHEMA | VOLUME} [IF NOT EXISTS]",
  "DROP {VIEW | MATERIALIZED VIEW | SCHEMA | CATALOG | VOLUME | FUNCTION} [IF EXISTS]",
  "DECLARE [OR REPLACE] [VARIABLE]",
  "SET VAR[IABLE]",
  "USE [CATALOG | SCHEMA]",
  "GRANT",
  "REVOKE",
  "OPTIMIZE",
  "ZORDER BY",
  "VACUUM",
  "DESCRIBE [TABLE] [EXTENDED | DETAIL | HISTORY]",
  "SHOW {CATALOGS | SCHEMAS | GRANTS | CREATE TABLE}",
  "COPY INTO",
  "CLUSTER BY",
  "TBLPROPERTIES",
]);

// Keywords that are also functions when called.
const keywordFunctions = new Set(["RANGE", "SESSION_USER", "IDENTIFIER", "LEFT", "RIGHT"]);

/**
 * A name written right against "(" is a function call, even if sql-formatter
 * does not know the function (UDFs, read_files, ai_query...). Without this the
 * formatter prints `read_files ('...')`.
 */
function markCalls(tokens: Tokens): Tokens {
  const out = base.postProcess ? base.postProcess(tokens) : tokens;
  return out.map((tok, i) => {
    const next = out[i + 1];
    const call =
      tok.type === "IDENTIFIER" || (tok.type === "RESERVED_KEYWORD" && keywordFunctions.has(tok.text));
    if (call && next?.type === "OPEN_PAREN" && next.start === tok.start + tok.raw.length) {
      return { ...tok, type: "RESERVED_FUNCTION_NAME" as typeof tok.type };
    }
    return tok;
  });
}

const databricks: DialectOptions = {
  name: "databricks",
  tokenizerOptions: {
    ...base,
    reservedClauses: [...base.reservedClauses, ...clauses, ...onelineClauses],
    operators: [...(base.operators ?? []), "=>", "::", "?::"],
    // `col:field.path` reads a field of a JSON string column.
    propertyAccessOperators: [":"],
    postProcess: markCalls,
  },
  formatOptions: {
    ...spark.formatOptions,
    alwaysDenseOperators: ["::", "?::"],
    onelineClauses: [...spark.formatOptions.onelineClauses, ...onelineClauses],
  },
};

/** Reformats SQL text, keeping a trailing newline if it had one. Throws when the text cannot be parsed. */
export function formatSql(text: string): string {
  if (!text.trim()) return text;
  const out = formatDialect(text, {
    dialect: databricks,
    keywordCase: "upper",
    tabWidth: 2,
    linesBetweenQueries: 1,
  });
  return /\n\s*$/.test(text) ? out + "\n" : out;
}

/**
 * Finds the offset in `after` that matches `offset` in `before`, where `after`
 * is `before` reformatted. Formatting only changes whitespace and letter case,
 * so counting non-space characters finds the same place in the code. A cursor
 * that follows whitespace stays in front of the next token; one that follows
 * a character stays right after it.
 */
export function mapOffset(before: string, after: string, offset: number): number {
  const space = (c: string) => /\s/.test(c);
  let n = 0;
  for (let i = 0; i < offset && i < before.length; i++) if (!space(before[i])) n++;
  const leading = offset === 0 || space(before[offset - 1]);
  let seen = 0;
  for (let i = 0; i < after.length; i++) {
    if (space(after[i])) continue;
    if (leading && seen === n) return i;
    if (++seen === n && !leading) return i + 1;
  }
  return after.length;
}
