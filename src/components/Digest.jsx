import React, { useEffect, useState } from "react";
import { base44 } from "../api/base44Client.js";
import { fmtDate } from "../lib/format.js";
import { parseMarkdown, splitBold } from "../lib/markdown.js";

// Digest — the weekly narrative the backend writes (weekly-digest fn), rendered
// from content_md with the tiny in-repo markdown renderer, plus a gallery of the
// AI-painted "weekly portraits" (cover_image_url).

function Bold({ text }) {
  const parts = splitBold(text);
  return parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : <React.Fragment key={i}>{p}</React.Fragment>));
}

function Markdown({ md }) {
  return parseMarkdown(md).map((b, i) => {
    if (b.type === "h") {
      const Tag = `h${Math.min(b.level + 2, 4)}`; // # → h3, ## → h4
      return <Tag key={i} className="md-h"><Bold text={b.text} /></Tag>;
    }
    if (b.type === "ul") {
      return (
        <ul key={i} className="md-ul">
          {b.items.map((it, j) => (
            <li key={j}><Bold text={it} /></li>
          ))}
        </ul>
      );
    }
    return <p key={i} className="md-p"><Bold text={b.text} /></p>;
  });
}

export default function Digest({ spaceId }) {
  const [digests, setDigests] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    setDigests(null);
    base44.entities.Digest.filter({ space_id: spaceId }, "-created_date", 30)
      .then((rows) => !cancelled && setDigests(rows))
      .catch(() => !cancelled && setDigests([]));
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (digests === null) {
    return (
      <div className="digest">
        <div className="card skeleton" style={{ height: 180 }} />
        <div className="card skeleton" style={{ height: 120 }} />
      </div>
    );
  }

  const covers = digests.map((d) => d.cover_image_url).filter(Boolean);

  return (
    <div className="digest">
      {covers.length > 0 && (
        <div className="portrait-gallery">
          {covers.map((url, i) => (
            <img key={i} src={url} alt="Weekly group portrait" loading="lazy" />
          ))}
        </div>
      )}

      {digests.length === 0 && (
        <div className="empty">
          <h2>No digests yet</h2>
          <p>Every Sunday 18:00 IST the hive writes your week up — decisions, debts, what's coming — and paints a group portrait. Your first one lands after a week of chat.</p>
        </div>
      )}

      {digests.map((d) => (
        <article key={d.id} className="digest-card card pop">
          <div className="meta">{fmtDate(d.period_start)} – {fmtDate(d.period_end ?? d.created_date)}</div>
          <div className="md-body">
            <Markdown md={d.content_md} />
          </div>
        </article>
      ))}
    </div>
  );
}
