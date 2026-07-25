import React, { useState } from "react";
import { base44 } from "../api/base44Client.js";

// AskPanel — dashboard face of the librarian. Same total-recall answers as
// /ask in Telegram, via the `ask` backend function.

const SUGGESTIONS = [
  "What's pending on me?",
  "What did we decide about the budget?",
  "How much have we spent so far?",
  "What's still unanswered?",
];

export default function AskPanel({ spaceId }) {
  const [q, setQ] = useState("");
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);

  async function ask(question) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setThread((t) => [...t, { role: "you", text: question }]);
    setQ("");
    try {
      const res = await base44.functions.invoke("ask", { space_id: spaceId, question });
      setThread((t) => [...t, { role: "hive", text: res?.answer ?? "…" }]);
    } catch (e) {
      setThread((t) => [...t, { role: "hive", text: "The librarian is momentarily unavailable — try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ask">
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => ask(s)} disabled={busy}>{s}</button>
        ))}
      </div>
      <div className="thread">
        {thread.length === 0 && <p className="muted">Ask anything the group has ever discussed — answers come with receipts.</p>}
        {thread.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>{m.text}</div>
        ))}
        {busy && <div className="bubble hive muted">🐝 checking the records…</div>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the librarian…" />
        <button type="submit" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </div>
  );
}
