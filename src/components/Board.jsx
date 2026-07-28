import React, { useEffect, useState, useCallback, useRef } from "react";
import { base44 } from "../api/base44Client.js";
import { fmtDate, money, tgSourceLink } from "../lib/format.js";
import { toast } from "../lib/toast.js";
import Provenance from "./Provenance.jsx";

// Board — five live columns. Each column loads once, then stays current purely
// through entity realtime subscriptions (create/update/delete events).
//
// Every card opens the Provenance drawer showing the exact source messages the
// row was compiled from. Buttons inside a card must stopPropagation() or they
// would also open the drawer.

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
        // _live marks a row that arrived over realtime while we were watching,
        // so the card can announce itself. Client-side only — never written back.
        if (event.type === "create") return [{ ...rec, _live: true }, ...cur.filter((x) => x.id !== event.id)];
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

// A compiled row. Clickable AND keyboard-operable — the drawer is the primary
// action, so it must not be mouse-only. No role="button": these cards contain
// their own buttons and links, and a button may not own interactive descendants.
function Card({ className = "", onActivate, children }) {
  return (
    <article
      className={`card pop ${className}`.trim()}
      tabIndex={0}
      aria-label="Show the source messages this was compiled from"
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
    </article>
  );
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

// Receipt count — how many source messages this row was compiled from.
function Receipts({ ids }) {
  const n = (ids ?? []).length;
  if (!n) return null;
  return <span className="receipts">🧾 {n}</span>;
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
  const [inspect, setInspect] = useState(null); // row whose provenance is open
  const receiptTurn = useRef(0); // latest-wins guard for the signed-url fetch

  const dismissReceipt = useCallback(() => {
    receiptTurn.current += 1; // any in-flight fetch is now stale — don't reopen
    setReceipt(null);
  }, []);

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
      const turn = ++receiptTurn.current;
      setReceipt("loading");
      try {
        const res = await base44.functions.invoke("get-signed-url", { file_uri: fileUri, space_id: spaceId });
        const body = res?.data ?? res; // invoke may return the raw axios response
        const url = body?.signed_url;
        if (!url) throw new Error("no url");
        if (receiptTurn.current !== turn) return; // dismissed while loading
        setReceipt(url);
      } catch {
        if (receiptTurn.current !== turn) return;
        setReceipt(null);
        toast("Couldn't open that receipt.");
      }
    },
    [spaceId],
  );

  // Esc closes the receipt modal.
  useEffect(() => {
    if (!receipt) return;
    const onKey = (e) => e.key === "Escape" && dismissReceipt();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [receipt, dismissReceipt]);

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
      <section className="col" data-kind="decision">
        <h3>✅ Decisions <span className="count">{decisions.filter((d) => d.status === "active").length}</span></h3>
        {dLoading ? (
          <SkeletonCards />
        ) : (
          decisions.map((d) => (
            <Card
              key={d.id}
              className={`${d.status === "superseded" ? "dim" : ""} ${d._live ? "fresh-card" : ""}`}
              onActivate={() => setInspect(d)}
            >
              <b>{d.title}</b>
              {d.detail && <p>{d.detail}</p>}
              <div className="meta">
                {d.status === "superseded" ? "superseded" : fmtDate(d.decided_at ?? d.created_date)}
                <Receipts ids={d.source_msg_ids} />
                <Sources space={space} ids={d.source_msg_ids} />
              </div>
            </Card>
          ))
        )}
      </section>

      <section className="col" data-kind="commitment">
        <h3>🤝 Commitments <span className="count">{commitments.filter((c) => c.status !== "done").length}</span></h3>
        {cLoading ? (
          <SkeletonCards />
        ) : (
          commitments.map((c) => (
            <Card
              key={c.id}
              className={`${c.status === "overdue" ? "danger" : ""} ${c.status === "done" ? "dim" : ""} ${c._live ? "fresh-card" : ""}`}
              onActivate={() => setInspect(c)}
            >
              <b>{c.who_name}</b> — {c.what}
              <div className="meta">
                {c.status === "done" ? "done ✓" : c.due_at ? `due ${fmtDate(c.due_at)}` : "no deadline"}
                <Receipts ids={c.source_msg_ids} />
                <Sources space={space} ids={c.source_msg_ids} />
                {c.status !== "done" && (
                  <button
                    className="mini"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      closeCommitment(c);
                    }}
                  >
                    mark done
                  </button>
                )}
              </div>
            </Card>
          ))
        )}
      </section>

      <section className="col" data-kind="question">
        <h3>❓ Questions <span className="count">{questions.filter((q) => q.status === "open").length}</span></h3>
        {qLoading ? (
          <SkeletonCards />
        ) : (
          questions.map((q) => (
            <Card
              key={q.id}
              className={`${q.status === "answered" ? "dim" : ""} ${q._live ? "fresh-card" : ""}`}
              onActivate={() => setInspect(q)}
            >
              <b>{q.text}</b>
              {q.answer && <p className="answer">→ {q.answer}</p>}
              <div className="meta">
                {q.status === "answered" ? `answered via ${q.answered_via}` : "open"}
                <Receipts ids={q.source_msg_ids} />
                <Sources space={space} ids={q.source_msg_ids} />
              </div>
            </Card>
          ))
        )}
      </section>

      <section className="col" data-kind="event">
        <h3>📅 Events <span className="count">{events.length}</span></h3>
        {eLoading ? (
          <SkeletonCards />
        ) : (
          events.map((e) => (
            <Card key={e.id} className={e._live ? "fresh-card" : ""} onActivate={() => setInspect(e)}>
              <b>{e.title}</b>
              <div className="meta">
                {fmtDate(e.starts_at)}
                {e.location ? ` · ${e.location}` : ""}
                <Receipts ids={e.source_msg_ids} />
                <Sources space={space} ids={e.source_msg_ids} />
              </div>
            </Card>
          ))
        )}
      </section>

      <section className="col" data-kind="expense">
        <h3>💸 Expenses <span className="count">{expenses.length}</span></h3>
        {xLoading ? (
          <SkeletonCards />
        ) : (
          expenses.map((x) => (
            <Card key={x.id} className={x._live ? "fresh-card" : ""} onActivate={() => setInspect(x)}>
              <b>{money(x.amount, x.currency)}</b> — {x.description || "expense"}
              <div className="meta">
                paid by {x.payer_name}{x.items?.length ? ` · ${x.items.length} items` : ""}
                <Receipts ids={x.source_msg_ids} />
                {x.receipt_file_uri && (
                  <button
                    className="mini"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      openReceipt(x.receipt_file_uri);
                    }}
                  >
                    🧾 receipt
                  </button>
                )}
                <Sources space={space} ids={x.source_msg_ids} />
              </div>
            </Card>
          ))
        )}
      </section>

      <Provenance spaceId={spaceId} item={inspect} onClose={() => setInspect(null)} />

      {receipt && (
        <div className="modal" onClick={dismissReceipt}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            {receipt === "loading" ? (
              <div className="muted" style={{ padding: 40 }}>Fetching receipt…</div>
            ) : (
              <img src={receipt} alt="Receipt" />
            )}
            <button className="mini modal-close" onClick={dismissReceipt}>close</button>
          </div>
        </div>
      )}
    </div>
  );
}
