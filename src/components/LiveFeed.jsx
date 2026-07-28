import React, { useEffect, useRef, useState } from "react";
import { useSource } from "../api/source.jsx";
import { timeAgo } from "../lib/format.js";

// LiveFeed — the "compiler output" stream. Subscribes to every compiled entity
// and prepends events as they happen, so a judge watching this tab during a
// live chat sees the group's brain grow in realtime.

const KINDS = [
  ["Decision", "✅", (r) => r.title],
  ["Commitment", "🤝", (r) => `${r.who_name} — ${r.what}`],
  ["Question", "❓", (r) => r.text],
  ["Event", "📅", (r) => r.title],
  ["Expense", "💸", (r) => `${r.payer_name}: ${r.description || r.amount}`],
];

export default function LiveFeed({ spaceId }) {
  const src = useSource();
  const [items, setItems] = useState([]);
  const [pulse, setPulse] = useState(false);
  const seen = useRef(new Set());

  useEffect(() => {
    setItems([]);
    seen.current = new Set();
    const unsubs = [];

    for (const [name, icon, label] of KINDS) {
      // backfill
      src.filter(name, { space_id: spaceId }, "-created_date", 20).then((rows) => {
        setItems((cur) =>
          [...cur, ...rows.map((r) => ({ id: `${name}:${r.id}`, icon, text: label(r), at: r.created_date, kind: name, live: false }))]
            .sort((a, b) => new Date(b.at) - new Date(a.at))
            .slice(0, 80),
        );
      });
      // live
      unsubs.push(
        src.subscribe(name, (event) => {
          if (event.type !== "create" || event.data?.space_id !== spaceId) return;
          const key = `${name}:${event.id}`;
          if (seen.current.has(key)) return;
          seen.current.add(key);
          setPulse(true);
          setTimeout(() => setPulse(false), 1200);
          setItems((cur) =>
            [{ id: key, icon, text: label(event.data), at: event.timestamp, kind: name, live: true }, ...cur].slice(0, 80),
          );
        }),
      );
    }
    return () => unsubs.forEach((u) => u());
  }, [spaceId, src]);

  return (
    <div className="feed">
      <div className={`compiler ${pulse ? "pulsing" : ""}`}>
        <span className="dot" />{" "}
        {src.demo
          ? "snapshot of a real compiled group — realtime needs a signed-in session"
          : pulse
            ? "compiling conversation…"
            : "watching the chat — this feed is live"}
      </div>
      {items.map((it) => (
        <div key={it.id} className={`feed-item pop ${it.live ? "fresh" : ""}`}>
          <span className="icon">{it.icon}</span>
          <span className="text">{it.text}</span>
          <span className="when muted">{it.kind} · {timeAgo(it.at)}</span>
        </div>
      ))}
      {items.length === 0 && <p className="muted">Nothing compiled yet — say something decisive in the group 😉</p>}
    </div>
  );
}
