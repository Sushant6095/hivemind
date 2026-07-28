// The demo reader: a tiny, pure query engine over one JSON snapshot.
//
// This file is deliberately React-free and dependency-free. It is the only part
// of the demo path that can be *wrong in a way the eye doesn't catch* — a filter
// that quietly matches everything, a sort that reverses under the wrong key —
// so it lives apart from the JSX and is covered directly by tests/source.test.mjs.
//
// It implements only the subset of the entity query language the dashboard
// panels actually use: equality `where`, a single `"-field"` / `"field"` sort,
// and a row limit. Anything richer belongs on the server, not here.

/** Equality match on every key the caller asked for.
 *
 *  Unknown keys simply don't match, which is the safe direction: a filter we
 *  don't understand returns nothing rather than everything. Comparison is
 *  string-coerced because Telegram message ids arrive as numbers from the API
 *  and as strings from `source_msg_ids`, and Provenance joins the two. */
export function matches(row, query) {
  return Object.entries(query ?? {}).every(([k, v]) => String(row?.[k]) === String(v));
}

/** `"-field"` = descending, `"field"` = ascending, anything else = as-stored. */
export function sortRows(rows, sort) {
  if (typeof sort !== "string" || !sort) return rows;
  const desc = sort.startsWith("-");
  const key = desc ? sort.slice(1) : sort;
  return [...rows].sort((a, b) => {
    const av = a?.[key], bv = b?.[key];
    // Dates and numbers both compare correctly once coerced; strings fall back
    // to locale-free comparison so ordering is stable across browsers.
    const an = Date.parse(av) || Number(av) || 0;
    const bn = Date.parse(bv) || Number(bv) || 0;
    const d = an === bn ? String(av ?? "").localeCompare(String(bv ?? "")) : an - bn;
    return desc ? -d : d;
  });
}

/**
 * A source backed by one `demo` function payload. Reads are synchronous in
 * spirit but keep the Promise shape so callers are unchanged; subscribe is a
 * no-op returning a real unsubscribe function, so cleanup code stays honest.
 */
export function demoSource(snapshot) {
  return {
    demo: true,
    snapshot,
    filter: async (name, query, sort, limit) => {
      const rows = (snapshot?.[name] ?? []).filter((r) => matches(r, query));
      const sorted = sortRows(rows, sort);
      return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
    },
    subscribe: () => () => {},
  };
}
