import { useEffect, useMemo, useRef, useState } from "react";
import type { Column } from "../../bindings/dbx-desktop/internal/sqlexec/models";

type Row = (string | null)[] | null;

const ROW_H = 26;
const HEAD_H = 30;
const NUM_W = 56;
const OVERSCAN = 12;

/** Column widths from the header and a sample of rows, in pixels. */
function measure(columns: Column[], rows: Row[]): number[] {
  const sample = rows.slice(0, 200);
  return columns.map((c, i) => {
    // The header shows the name and the type side by side.
    let chars = c.name.length + c.type.length * 0.8 + 1;
    for (const r of sample) {
      const v = r?.[i];
      chars = Math.max(chars, v === null || v === undefined ? 4 : Math.min(v.length, 60));
    }
    return Math.round(Math.min(420, Math.max(80, chars * 7.4 + 26)));
  });
}

/**
 * A read-only grid that draws only the rows in view, so ten thousand rows
 * scroll as smoothly as ten.
 */
export function ResultsGrid(props: { columns: Column[]; rows: Row[] }) {
  const { columns, rows } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  const widths = useMemo(() => measure(columns, rows), [columns, rows]);
  const total = NUM_W + widths.reduce((a, b) => a + b, 0);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    setScrollTop(0);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [rows]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const visible: number[] = [];
  for (let i = first; i < last; i++) visible.push(i);

  return (
    <div
      className="grid-scroll"
      ref={scroller}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role="table"
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + 1}
      tabIndex={0}
    >
      <div style={{ width: total, height: HEAD_H + rows.length * ROW_H, position: "relative" }}>
        <div className="grid-head" role="row" style={{ height: HEAD_H, width: total }}>
          <div className="grid-cell num" style={{ width: NUM_W }} role="columnheader" aria-label="Row number" />
          {columns.map((c, i) => (
            <div
              key={i}
              className="grid-cell"
              style={{ width: widths[i] }}
              role="columnheader"
              title={`${c.name} (${c.type})`}
            >
              <span className="col-name">{c.name}</span>
              <span className="col-type">{c.type}</span>
            </div>
          ))}
        </div>
        {visible.map((i) => {
          const row = rows[i] ?? [];
          return (
            <div
              key={i}
              className="grid-row"
              role="row"
              aria-rowindex={i + 2}
              style={{ top: HEAD_H + i * ROW_H, height: ROW_H, width: total }}
            >
              <div className="grid-cell num" style={{ width: NUM_W }} role="cell">
                {i + 1}
              </div>
              {columns.map((_, j) => {
                const v = row[j];
                return (
                  <div
                    key={j}
                    className={v === null || v === undefined ? "grid-cell null" : "grid-cell"}
                    style={{ width: widths[j] }}
                    role="cell"
                    title={v ?? "NULL"}
                  >
                    {v === null || v === undefined ? "NULL" : v}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
