import React, { useEffect, useState, useCallback } from "react";
import { base44 } from "../api/base44Client.js";
import { fmtDate, money } from "../lib/format.js";

// Board — five live columns. Each column loads once, then stays current purely
// through entity realtime subscriptions (create/update/delete events).

function useLiveEntity(name, spaceId) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const handler = base44.entities[name];
    handler.filter({ space_id: spaceId }, "-created_date", 100).then((r) => !cancelled && setRows(r));

    const unsubscribe = handler.subscribe((event) => {
      const rec = event.data;
      if (rec?.space_id !== spaceId) return;
      setRows((cur) => {
        if (event.type === "create") return [rec, ...cur.filter((x) => x.id !== event.id)];
        if (event.type === "update") return cur.map((x) => (x.id === event.id ? rec : x));
        if (event.type === "delete") return cur.filter((x) => x.id !== event.id);
        return cur;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [name, spaceId]);

  return [rows, setRows];
}

export default function Board({ spaceId }) {
  const [decisions] = useLiveEntity("Decision", spaceId);
  const [commitments, setCommitments] = useLiveEntity("Commitment", spaceId);
  const [questions] = useLiveEntity("Question", spaceId);
  const [events] = useLiveEntity("Event", spaceId);
  const [expenses] = useLiveEntity("Expense", spaceId);

  const closeCommitment = useCallback(
    async (c) => {
      setCommitments((cur) => cur.map((x) => (x.id === c.id ? { ...x, status: "done" } : x)));
      await base44.functions.invoke("mark-done", { space_id: spaceId, commitment_id: c.id }).catch(() => {});
    },
    [spaceId, setCommitments],
  );

  return (
    <div className="board">
      <section className="col">
        <h3>✅ Decisions <span className="count">{decisions.filter((d) => d.status === "active").length}</span></h3>
        {decisions.map((d) => (
          <article key={d.id} className={`card pop ${d.status === "superseded" ? "dim" : ""}`}>
            <b>{d.title}</b>
            {d.detail && <p>{d.detail}</p>}
            <div className="meta">{d.status === "superseded" ? "superseded" : fmtDate(d.decided_at ?? d.created_date)}</div>
          </article>
        ))}
      </section>

      <section className="col">
        <h3>🤝 Commitments <span className="count">{commitments.filter((c) => c.status !== "done").length}</span></h3>
        {commitments.map((c) => (
          <article key={c.id} className={`card pop ${c.status === "overdue" ? "danger" : ""} ${c.status === "done" ? "dim" : ""}`}>
            <b>{c.who_name}</b> — {c.what}
            <div className="meta">
              {c.status === "done" ? "done ✓" : c.due_at ? `due ${fmtDate(c.due_at)}` : "no deadline"}
              {c.status !== "done" && (
                <button className="mini" onClick={() => closeCommitment(c)}>mark done</button>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="col">
        <h3>❓ Questions <span className="count">{questions.filter((q) => q.status === "open").length}</span></h3>
        {questions.map((q) => (
          <article key={q.id} className={`card pop ${q.status === "answered" ? "dim" : ""}`}>
            <b>{q.text}</b>
            {q.answer && <p className="answer">→ {q.answer}</p>}
            <div className="meta">{q.status === "answered" ? `answered via ${q.answered_via}` : "open"}</div>
          </article>
        ))}
      </section>

      <section className="col">
        <h3>📅 Events <span className="count">{events.length}</span></h3>
        {events.map((e) => (
          <article key={e.id} className="card pop">
            <b>{e.title}</b>
            <div className="meta">
              {fmtDate(e.starts_at)}
              {e.location ? ` · ${e.location}` : ""}
            </div>
          </article>
        ))}
      </section>

      <section className="col">
        <h3>💸 Expenses <span className="count">{expenses.length}</span></h3>
        {expenses.map((x) => (
          <article key={x.id} className="card pop">
            <b>{money(x.amount, x.currency)}</b> — {x.description || "expense"}
            <div className="meta">paid by {x.payer_name}{x.items?.length ? ` · ${x.items.length} items from receipt` : ""}</div>
          </article>
        ))}
      </section>
    </div>
  );
}
