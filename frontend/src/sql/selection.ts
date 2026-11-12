/** Applies a click to the selection: plain toggles one, shift extends a range from the anchor. */
export function nextSelection(
  order: string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  path: string,
  shift: boolean,
): Set<string> {
  const next = new Set(selected);
  const from = anchor ? order.indexOf(anchor) : -1;
  const to = order.indexOf(path);
  if (shift && from >= 0 && to >= 0) {
    const [a, b] = from < to ? [from, to] : [to, from];
    for (const p of order.slice(a, b + 1)) next.add(p);
    return next;
  }
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
