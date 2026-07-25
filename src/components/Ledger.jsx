import React, { useEffect, useState } from "react";
import { base44 } from "../api/base44Client.js";
import { money } from "../lib/format.js";

// Ledger — who-owes-who, computed client-side from compiled Expenses (equal
// split when the pipeline didn't produce an explicit split array).

export default function Ledger({ spaceId }) {
  const [expenses, setExpenses] = useState([]);
  const [members, setMembers] = useState([]);

  useEffect(() => {
    base44.entities.Expense.filter({ space_id: spaceId }, "-created_date", 200).then(setExpenses);
    base44.entities.Membership.filter({ space_id: spaceId }, undefined, 50).then(setMembers);
    const unsub = base44.entities.Expense.subscribe((event) => {
      if (event.data?.space_id !== spaceId) return;
      setExpenses((cur) => (event.type === "create" ? [event.data, ...cur] : cur.map((x) => (x.id === event.id ? event.data : x))));
    });
    return unsub;
  }, [spaceId]);

  const names = [...new Set([...members.map((m) => m.tg_display_name || m.user_email), ...expenses.map((x) => x.payer_name)])].filter(Boolean);
  const net = Object.fromEntries(names.map((n) => [n, 0]));

  for (const x of expenses) {
    const split = x.split?.length ? x.split : names.map((n) => ({ name: n, share: (x.amount ?? 0) / (names.length || 1) }));
    net[x.payer_name] = (net[x.payer_name] ?? 0) + (x.amount ?? 0);
    for (const s of split) net[s.name] = (net[s.name] ?? 0) - (s.share ?? 0);
  }

  const total = expenses.reduce((s, x) => s + (x.amount ?? 0), 0);
  const currency = expenses[0]?.currency ?? "INR";

  return (
    <div className="ledger">
      <div className="stat-row">
        <div className="stat"><b>{money(total, currency)}</b><span>tracked</span></div>
        <div className="stat"><b>{expenses.length}</b><span>expenses</span></div>
        <div className="stat"><b>{names.length}</b><span>people</span></div>
      </div>
      <h3>Net positions</h3>
      {Object.entries(net)
        .sort((a, b) => b[1] - a[1])
        .map(([name, v]) => (
          <div key={name} className="ledger-row">
            <span>{name}</span>
            <span className={v >= 0 ? "pos" : "neg"}>
              {v >= 0 ? "is owed " : "owes "}
              {money(Math.abs(Math.round(v)), currency)}
            </span>
          </div>
        ))}
      {expenses.length === 0 && <p className="muted">Drop a receipt photo in the group — it becomes an itemized expense here.</p>}
    </div>
  );
}
