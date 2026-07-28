import React, { useEffect, useState, useCallback } from "react";
import { base44 } from "../api/base44Client.js";
import { fmtDate, money, tgSourceLink } from "../lib/format.js";
import { toast } from "../lib/toast.js";

// Board — five live columns. Each column loads once, then stays current purely
// through entity realtime subscriptions (create/update/delete events).

function useLiveEntity(name, spaceId) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handler = base44.entities[name];
    handler
      .filter({ space_id: spaceId }, "-created_date", 100)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));

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

  return [rows, setRows, loading];
}

// "sources ↗" — hidden when the space can't be deep-linked (see tgSourceLink).
function Sources({ space, ids }) {
  const href = tgSourceLink(space, ids);
  if (!href) return null;
  return (
    <a className="src" href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      sources ↗
    </a>
  );
}

function SkeletonCards() {
  return (
    <>
      <div className="card skeleton" style={{ height: 58 }} />
      <div className="card skeleton" style={{ height: 44 }} />
    </>
  );
}

export default function Board({ space }) {
  const spaceId = space.id;
  const [decisions, , dLoading] = useLiveEntity("Decision", spaceId);
  const [commitments, setCommitments, cLoading] = useLiveEntity("Commitment", spaceId);
  const [questions, , qLoading] = useLiveEntity("Question", spaceId);
  const [events, , eLoading] = useLiveEntity("Event", spaceId);
  const [expenses, , xLoading] = useLiveEntity("Expense", spaceId);

  const [receipt, setReceipt] = useState(null); // null | "loading" | url

  const closeCommitment = useCallback(
    async (c) => {
      setCommitments((cur) => cur.map((x) => (x.id === c.id ? { ...x, status: "done" } : x)));
      try {
        await base44.functions.invoke("mark-done", { space_id: spaceId, commitment_id: c.id });
      } catch {
        toast("Couldn't mark that done — try again.");
      }
    },
    [spaceId, setCommitments],
  );

  const openReceipt = useCallback(
    async (fileUri) => {
      setReceipt("loading");
      try {
        const res = await base44.functions.invoke("get-signed-url", { file_uri: fileUri, space_id: spaceId });
        const body = res?.data ?? res; // invoke may return the raw axios response
        const url = body?.signed_url;
        if (!url) throw new Error("no url");
        setReceipt(url);
      } catch {
        setReceipt(null);
        toast("Couldn't open that receipt.");
      }
    },
    [spaceId],
  );

  // Esc closes the receipt modal.
  useEffect(() => {
    if (!receipt) return;
    const onKey = (e) => e.key === "Escape" && setReceipt(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [receipt]);

  const loading = dLoading && cLoading && qLoading && eLoading && xLoading;
  const total = decisions.length + commitments.length + questions.length + events.length + expenses.length;

  if (!loading && total === 0) {
    return (
      <div className="center">
        <div className="empty">
          <h2>Nothing compiled yet</h2>
          <p>Say something decisive in the group — "let's do Friday, Priya books it" — and watch a decision and a commitment land here, live.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="board">
      <section className="col">
        <h3>✅ Decisions <span className="count">{decisions.filter((d) => d.status === "active").length}</span></h3>
        {dLoading ? (
          <SkeletonCards />
        ) : (
          decisions.map((d) => (
            <article key={d.id} className={`card pop ${d.status === "superseded" ? "dim" : ""}`}>
              <b>{d.title}</b>
              {d.detail && <p>{d.detail}</p>}
              <div className="meta">
                {d.status === "superseded" ? "superseded" : fmtDate(d.decided_at ?? d.created_date)}
                <Sources space={space} ids={d.source_msg_ids} />
              </div>
            </article>
          ))
        )}
      </section>

      <section className="col">
        <h3>🤝 Commitments <span className="count">{commitments.filter((c) => c.status !== "done").length}</span></h3>
        {cLoading ? (
          <SkeletonCards />
        ) : (
          commitments.map((c) => (
            <article key={c.id} className={`card pop ${c.status === "overdue" ? "danger" : ""} ${c.status === "done" ? "dim" : ""}`}>
              <b>{c.who_name}</b> — {c.what}
              <div className="meta">
                {c.status === "done" ? "done ✓" : c.due_at ? `due ${fmtDate(c.due_at)}` : "no deadline"}
                <Sources space={space} ids={c.source_msg_ids} />
                {c.status !== "done" && (
                  <button className="mini" onClick={() => closeCommitment(c)}>mark done</button>
                )}
              </div>
            </article>
          ))
        )}
      </section>

      <section className="col">
        <h3>❓ Questions <span className="count">{questions.filter((q) => q.status === "open").length}</span></h3>
        {qLoading ? (
          <SkeletonCards />
        ) : (
          questions.map((q) => (
            <article key={q.id} className={`card pop ${q.status === "answered" ? "dim" : ""}`}>
              <b>{q.text}</b>
              {q.answer && <p className="answer">→ {q.answer}</p>}
              <div className="meta">
                {q.status === "answered" ? `answered via ${q.answered_via}` : "open"}
                <Sources space={space} ids={q.source_msg_ids} />
              </div>
            </article>
          ))
        )}
      </section>

      <section className="col">
        <h3>📅 Events <span className="count">{events.length}</span></h3>
        {eLoading ? (
          <SkeletonCards />
        ) : (
          events.map((e) => (
            <article key={e.id} className="card pop">
              <b>{e.title}</b>
              <div className="meta">
                {fmtDate(e.starts_at)}
                {e.location ? ` · ${e.location}` : ""}
                <Sources space={space} ids={e.source_msg_ids} />
              </div>
            </article>
          ))
        )}
      </section>

      <section className="col">
        <h3>💸 Expenses <span className="count">{expenses.length}</span></h3>
        {xLoading ? (
          <SkeletonCards />
        ) : (
          expenses.map((x) => (
            <article key={x.id} className="card pop">
              <b>{money(x.amount, x.currency)}</b> — {x.description || "expense"}
              <div className="meta">
                paid by {x.payer_name}{x.items?.length ? ` · ${x.items.length} items` : ""}
                {x.receipt_file_uri && (
                  <button className="mini" onClick={() => openReceipt(x.receipt_file_uri)}>🧾 receipt</button>
                )}
                <Sources space={space} ids={x.source_msg_ids} />
              </div>
            </article>
          ))
        )}
      </section>

      {receipt && (
        <div className="modal" onClick={() => setReceipt(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            {receipt === "loading" ? (
              <div className="muted" style={{ padding: 40 }}>Fetching receipt…</div>
            ) : (
              <img src={receipt} alt="Receipt" />
            )}
            <button className="mini modal-close" onClick={() => setReceipt(null)}>close</button>
          </div>
        </div>
      )}
    </div>
  );
}
