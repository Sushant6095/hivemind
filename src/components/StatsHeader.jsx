import React, { useEffect, useState } from "react";
import { base44 } from "../api/base44Client.js";
import { money } from "../lib/format.js";

// StatsHeader — three-number pulse of a space: messages seen (from Space.stats,
// maintained by the webhook) · records compiled · ₹ tracked (from loaded
// entities). One lightweight fetch per space; the live feel lives in the Board.

const KINDS = ["Decision", "Commitment", "Question", "Event"];

export default function StatsHeader({ space }) {
  const [compiled, setCompiled] = useState(null); // null = loading
  const [tracked, setTracked] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCompiled(null);
    Promise.all([
      ...KINDS.map((k) => base44.entities[k].filter({ space_id: space.id }, undefined, 1000, 0, ["id"])),
      base44.entities.Expense.filter({ space_id: space.id }, undefined, 1000, 0, ["id", "amount", "currency"]),
    ])
      .then((results) => {
        if (cancelled) return;
        const expenses = results[results.length - 1];
        setCompiled(results.reduce((n, rows) => n + rows.length, 0));
        setTracked(expenses.reduce((s, x) => s + (x.amount ?? 0), 0));
      })
      .catch(() => !cancelled && setCompiled(0));
    return () => {
      cancelled = true;
    };
  }, [space.id]);

  const messages = space.stats?.messages_seen ?? 0;

  return (
    <div className="stats-header">
      <div className="stat-pill">
        <b>{messages.toLocaleString("en-IN")}</b>
        <span>messages seen</span>
      </div>
      <div className="stat-pill">
        <b className={compiled === null ? "skeleton-text" : ""}>{compiled === null ? "" : compiled}</b>
        <span>records compiled</span>
      </div>
      <div className="stat-pill">
        <b className={compiled === null ? "skeleton-text" : ""}>{compiled === null ? "" : money(tracked)}</b>
        <span>tracked</span>
      </div>
    </div>
  );
}
