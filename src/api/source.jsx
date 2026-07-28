import React, { createContext, useContext } from "react";
import { base44 } from "./base44Client.js";
import { demoSource } from "./demoSource.js";

// Where a panel gets its rows.
//
// The dashboard has two readers with identical UI and completely different
// plumbing: a signed-in member reads entities directly (RLS scopes them) and
// keeps current over realtime; an anonymous visitor on the demo path has no
// session at all, so no entity read and no socket is possible — the whole board
// arrives once from the public `demo` function.
//
// Rather than fork the components, both are expressed as the same tiny surface:
//   filter(name, ...args) → rows        (same args as base44.entities[n].filter)
//   subscribe(name, cb)   → unsubscribe
// so Board/LiveFeed/Provenance/StatsHeader are written once and run either way.
//
// The demo half of that surface is a pure function over one JSON payload, so it
// lives in ./demoSource.js where node can import and test it without JSX.

export const liveSource = {
  demo: false,
  filter: (name, ...args) => base44.entities[name].filter(...args),
  subscribe: (name, cb) => base44.entities[name].subscribe(cb),
};

export { demoSource };

// The default IS the live source, so the signed-in tree needs no provider and
// behaves exactly as it did before the demo existed.
const SourceContext = createContext(liveSource);

export function SourceProvider({ source, children }) {
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>;
}

export function useSource() {
  return useContext(SourceContext);
}
