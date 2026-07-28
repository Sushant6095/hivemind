import React, { useEffect, useState } from "react";
import { useSource } from "../api/source.jsx";
import { fmtDate } from "../lib/format.js";

// Provenance drawer — the receipts. Given a compiled row, show the exact source
// messages it was extracted from. This is the anti-hallucination proof, so it
// must never assert something it hasn't actually verified.
//
// source_msg_ids holds TELEGRAM message ids, not Base44 row ids. We look each one
// up by equality (the pattern telegram-webhook already uses for tg_update_id) —
// NOT with $in (operator support unconfirmed) and NOT by scanning a recent window.
// A window scan silently misses provenance for anything older than the window,
// which is most of the board right after a history import.
// If exact lookups come back empty we fall back to a recent-window scan once, to
// survive any id-format drift between the extractor and the stored rows.

const MAX_LOOKUPS = 12; // source_msg_ids is typically 1-3; bound the fan-out
const FALLBACK_WINDOW = 200;

export default function Provenance({ spaceId, item, onClose }) {
  const src = useSource();
  const [msgs, setMsgs] = useState(null); // null = loading, [] = none found
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setMsgs(null); // re-show loading, never the previous row's receipts
    setError(false);

    const ids = [...new Set((item.source_msg_ids ?? []).map(String))];
    if (ids.length === 0) {
      setMsgs([]); // nothing was recorded — say exactly that, don't invent a reason
      return () => {
        cancelled = true;
      };
    }

    const byId = ids.slice(0, MAX_LOOKUPS).map((id) =>
      src.filter("RawMessage", { space_id: spaceId, tg_message_id: id }, undefined, 1),
    );

    Promise.all(byId)
      .then(async (results) => {
        let found = results.flat().filter(Boolean);
        // Fallback: ids exist but exact lookup found nothing → try a window scan.
        if (found.length === 0) {
          const recent = await src.filter("RawMessage", { space_id: spaceId }, "-sent_at", FALLBACK_WINDOW);
          const want = new Set(ids);
          found = recent.filter((m) => want.has(String(m.tg_message_id)));
        }
        if (cancelled) return;
        setMsgs(found.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at)));
      })
      .catch(() => {
        if (cancelled) return;
        setError(true); // a failed fetch is NOT "these messages are old"
        setMsgs([]);
      });

    return () => {
      cancelled = true;
    };
  }, [item, spaceId, src]);

  // Esc closes the drawer, matching the receipt modal's behaviour.
  useEffect(() => {
    if (!item) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;
  const n = (item.source_msg_ids ?? []).length;
  const truncated = n > MAX_LOOKUPS;

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Source messages">
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

        {/* Three genuinely different empty states — never one message for all three. */}
        {msgs && msgs.length === 0 && error && (
          <p className="muted">Couldn't load the receipts just now — close and try again.</p>
        )}
        {msgs && msgs.length === 0 && !error && n === 0 && (
          <p className="muted">No source messages were recorded for this row.</p>
        )}
        {msgs && msgs.length === 0 && !error && n > 0 && (
          <p className="muted">
            Those {n} source message{n === 1 ? "" : "s"} are no longer readable from here — still stored, but outside
            what this view can fetch.
          </p>
        )}

        {msgs?.map((m) => (
          <div key={m.id} className="src-msg">
            <b>{m.sender_name || "someone"}</b>
            <p>{m.text || (m.media_type !== "none" ? `[${m.media_type}]` : "")}</p>
            <span className="muted">{fmtDate(m.sent_at)}</span>
          </div>
        ))}

        {truncated && msgs?.length > 0 && (
          <p className="muted">Showing the first {MAX_LOOKUPS} of {n} source messages.</p>
        )}
      </aside>
    </div>
  );
}
