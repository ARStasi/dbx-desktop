/**
 * Reads and writes Python notebooks in Databricks source format, the form
 * the workspace exports with format SOURCE:
 *
 *   # Databricks notebook source
 *   print("first cell")
 *
 *   # COMMAND ----------
 *
 *   # MAGIC %sql
 *   # MAGIC SELECT 1
 *
 * Cells are separated by COMMAND lines. A cell in another language starts
 * with a magic such as %sql or %md, and every line of it is prefixed with
 * "# MAGIC" so the file stays valid Python. "# DBTITLE 1,<title>" on a cell's
 * first line holds its title.
 */

export const HEADER = "# Databricks notebook source";
const SEPARATOR = "# COMMAND ----------";
const SEPARATOR_RE = /^# COMMAND -{10,}\s*$/;
const MAGIC_RE = /^# MAGIC(?: (.*))?$/;
const TITLE_RE = /^# DBTITLE \d+,(.*)$/;

export interface Cell {
  /** Stable within one editing session; not saved. */
  id: string;
  /** The cell's text as edited, with any magic such as %sql on the first line. */
  source: string;
  /** The cell title, or empty. */
  title: string;
}

let nextId = 0;
export function newCellId(): string {
  nextId += 1;
  return `c${nextId}`;
}

export function newCell(source = "", title = ""): Cell {
  return { id: newCellId(), source, title };
}

/** Drops blank lines at the start and end, keeping indentation. */
function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}

function parseCell(lines: string[]): Cell {
  lines = trimBlankLines(lines);
  let title = "";
  const m = lines.length > 0 ? TITLE_RE.exec(lines[0]) : null;
  if (m) {
    title = m[1];
    lines = trimBlankLines(lines.slice(1));
  }
  // A magic cell has every line prefixed; anything else is Python.
  if (lines.length > 0 && lines.every((l) => MAGIC_RE.test(l))) {
    lines = lines.map((l) => MAGIC_RE.exec(l)![1] ?? "");
  }
  return newCell(lines.join("\n"), title);
}

/**
 * Splits notebook source into cells. A file without the header is treated as
 * one Python cell, so plain .py scripts open too. There is always at least one
 * cell.
 */
export function parseNotebook(text: string): Cell[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== HEADER) {
    return [parseCell(lines)];
  }
  const cells: Cell[] = [];
  let current: string[] = [];
  for (const line of lines.slice(1)) {
    if (SEPARATOR_RE.test(line)) {
      cells.push(parseCell(current));
      current = [];
    } else {
      current.push(line);
    }
  }
  cells.push(parseCell(current));
  return cells.length > 0 ? cells : [newCell()];
}

/** True when a cell's first line is a magic such as %sql or %md. */
export function isMagic(source: string): boolean {
  return /^\s*%[A-Za-z]/.test(source);
}

function serializeCell(cell: Cell): string {
  const lines = trimBlankLines(cell.source.replace(/\r\n?/g, "\n").split("\n"));
  const body = isMagic(cell.source) ? lines.map((l) => (l === "" ? "# MAGIC" : `# MAGIC ${l}`)) : lines;
  const title = cell.title.trim() ? [`# DBTITLE 1,${cell.title.trim()}`] : [];
  return [...title, ...body].join("\n");
}

/** Writes cells as Databricks notebook source. */
export function serializeNotebook(cells: Cell[]): string {
  return `${HEADER}\n${cells.map(serializeCell).join(`\n\n${SEPARATOR}\n\n`)}\n`;
}
