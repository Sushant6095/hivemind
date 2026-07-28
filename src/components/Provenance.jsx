import React, { useEffect, useState } from "react";
import { base44 } from "../api/base44Client.js";
import { fmtDate } from "../lib/format.js";

// Provenance drawer — the receipts. Given a compiled row, show the exact
// source messages it was extracted from. This is the anti-hallucination proof.
//
// source_msg_ids holds TELEGRAM message ids, not Base44 row ids, so we fetch the
// space's recent RawMessage rows once and match client-side rather than relying
// on $in operator support for a non-id field.

export default function Provenance({ spaceId, item, onClose }) {
  const [msgs, setMsgs] = useState(null); // null = loading

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setMsgs(null);
    const ids = new Set((item.source_msg_ids ?? []).map(String));
    base44.entities.RawMessage
      .filter({ space_id: spaceId }, "-sent_at", 200)
      .then((rows) => {
        if (cancelled) return;
        setMsgs(
          rows
            .filter((m) => ids.has(String(m.tg_message_id)))
            .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at)),
        );
      })
      .catch(() => !cancelled && setMsgs([]));
    return () => {
      cancelled = true;
    };
  }, [item, spaceId]);

  // Esc closes the drawer, matching the receipt modal's behaviour.
  useEffect(() => {
    if (!item) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;
  const n = (item.source_msg_ids ?? []).length;

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h3>{item.title ?? item.what ?? item.text ?? item.description ?? "Receipts"}</h3>
            <p className="muted">
              extracted from {n} message{n === 1 ? "" : "s"}
              {typeof item.confidence === "number"
                ? ` · ${Math.round(item.confidence * 100)}% confidence`
                : ""}
            </p>
          </div>
          <button className="chip" onClick={onClose}>close</button>
        </div>
        {msgs === null && <p className="muted">Pulling the receipts…</p>}
        {msgs?.length === 0 && (
          <p className="muted">
            Source messages are older than this view loads — still stored, just outside the recent window.
          </p>
        )}
        {msgs?.map((m) => (
          <div key={m.id} className="src-msg">
            <b>{m.sender_name || "someone"}</b>
            <p>{m.text || (m.media_type !== "none" ? `[${m.media_type}]` : "")}</p>
            <span className="muted">{fmtDate(m.sent_at)}</span>
          </div>
        ))}
      </aside>
    </div>
  );
}
