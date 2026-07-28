import React, { useEffect, useRef, useState } from "react";
import { base44 } from "../api/base44Client.js";
import { timeAgo } from "../lib/format.js";

// EngineRoom — owner-only observability tab. Two things an operator/judge wants:
//   1. the raw app-log tail (what the backend is doing), auto-refreshed
//   2. the rolling counters the pipeline has accumulated
//
// Counters are sourced from Space.stats, NOT analytics: base44.analytics.track()
// is WRITE-only per the SDK docs (no read/query API), so there is nothing to
// query back. app-logs, by contrast, exposes fetchLogs() — that feeds the tail.

const REFRESH_MS = 4000;
const LOG_LIMIT = 50;

function normalizeLogs(res) {
  if (Array.isArray(res)) return res;
  return res?.logs ?? res?.data ?? res?.items ?? res?.results ?? [];
}

// fetchLogs() shape isn't guaranteed by the docs — render defensively.
function logLine(row) {
  if (row == null) return "";
  if (typeof row === "string") return row;
  const who = row.user_email || row.user || row.actor || "";
  const what = row.page || row.page_name || row.action || row.event || row.message || row.path || "";
  const line = [who, what].filter(Boolean).join("  ·  ");
  return line || JSON.stringify(row);
}

function logWhen(row) {
  const when = row?.created_date || row?.timestamp || row?.time || row?.at;
  return when ? timeAgo(when) : "";
}

const term = {
  border: "1px solid var(--line)",
  borderRadius: 12,
  overflow: "hidden",
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
};

export default function EngineRoom({ space }) {
  const [logs, setLogs] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await base44.appLogs.fetchLogs({ limit: LOG_LIMIT });
        if (cancelled) return;
        setLogs(normalizeLogs(res).slice(0, LOG_LIMIT));
        setErr(null);
        setTick((t) => !t);
      } catch (_) {
        if (!cancelled) setErr("app-logs unavailable (module may be frontend-scoped or not enabled)");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    pull();
    const t = setInterval(pull, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const stats = space?.stats && typeof space.stats === "object" ? space.stats : {};
  const counters = Object.entries(stats).filter(([, v]) => v != null && typeof v !== "object");

  return (
    <div style={{ maxWidth: 840 }}>
      {/* rolling counters — from Space.stats (analytics.track is write-only) */}
      {counters.length > 0 ? (
        <div className="stat-row" style={{ flexWrap: "wrap" }}>
          {counters.map(([k, v]) => (
            <div className="stat" key={k}>
              <b>{typeof v === "number" ? v : String(v)}</b>
              <span>{k.replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ marginBottom: 20 }}>
          No rolling counters yet — <code>Space.stats</code> is empty for this space.
        </p>
      )}

      {/* terminal-esque live tail of app-logs */}
      <div style={term}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 14px",
            background: "var(--panel)",
            borderBottom: "1px solid var(--line)",
            fontSize: 12.5,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: err ? "var(--red)" : "var(--green)",
              boxShadow: err ? "none" : "0 0 6px var(--green)",
              transition: "opacity .3s",
              opacity: tick ? 1 : 0.5,
            }}
          />
          <span style={{ color: "var(--honey)" }}>engine-room</span>
          <span className="muted">— live tail · app-logs · every {REFRESH_MS / 1000}s</span>
          <span className="muted" style={{ marginLeft: "auto" }}>{logs.length} lines</span>
        </div>
        <div
          style={{
            background: "var(--bg)",
            maxHeight: 440,
            overflowY: "auto",
            padding: "10px 14px",
            fontSize: 12.5,
            lineHeight: 1.75,
          }}
        >
          {err && <div style={{ color: "var(--red)" }}>! {err}</div>}
          {!err && loading && <div className="muted">connecting to app-logs…</div>}
          {!err && !loading && logs.length === 0 && (
            <div className="muted">no log lines yet — activity will stream in here.</div>
          )}
          {logs.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              <span style={{ color: "var(--honey-dim)", flex: "none" }}>›</span>
              <span style={{ color: "var(--text)", flex: 1 }}>{logLine(row)}</span>
              <span className="muted" style={{ flex: "none" }}>{logWhen(row)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
