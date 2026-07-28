import React, { useEffect, useState } from "react";
import { base44 } from "../api/base44Client.js";
import { timeAgo } from "../lib/format.js";

// Ops — the difference between "I built features" and "I run a system".
// Everything here is derived client-side from MetricEvent + CompileJob rows;
// no new endpoint, no server-side aggregation.

const DAY_MS = 24 * 60 * 60 * 1000;

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export default function OpsPanel({ spaceId }) {
  const [metrics, setMetrics] = useState(null);
  const [jobs, setJobs] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      base44.entities.MetricEvent
        .filter({ space_id: spaceId }, "-created_date", 200)
        .then((r) => !cancelled && setMetrics(r))
        .catch(() => !cancelled && setMetrics([]));
      base44.entities.CompileJob
        .filter({ space_id: spaceId }, "-created_date", 5)
        .then((r) => !cancelled && setJobs(r))
        .catch(() => !cancelled && setJobs([]));
    };
    load();
    const t = setInterval(load, 10_000); // cheap poll; these are small collections
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [spaceId]);

  if (metrics === null || jobs === null) {
    return (
      <div className="ops">
        <div className="card skeleton" style={{ height: 64 }} />
        <div className="card skeleton" style={{ height: 120 }} />
      </div>
    );
  }

  const cutoff = Date.now() - DAY_MS;
  const recent = metrics.filter((m) => new Date(m.created_date).getTime() >= cutoff);
  const compiles = recent.filter((m) => m.kind === "compile");
  const durations = compiles.map((m) => m.duration_ms).filter((d) => typeof d === "number").sort((a, b) => a - b);
  const okCount = compiles.filter((m) => m.ok !== false).length;
  const successRate = compiles.length ? Math.round((okCount / compiles.length) * 100) : null;
  const extracted = compiles.reduce((s, m) => s + (m.meta?.extracted ?? 0), 0);

  const ms = (v) => (v === null || v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

  if (metrics.length === 0 && jobs.length === 0) {
    return (
      <div className="center">
        <div className="empty">
          <h2>No runs recorded yet</h2>
          <p>
            Every compile writes a durable job record and a metric event. Send a burst to the group and this fills with
            latency percentiles, success rate and the job state machine.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ops">
      <div className="stats-header">
        <div className="stat-pill"><b>{compiles.length}</b><span>compiles · 24h</span></div>
        <div className="stat-pill"><b>{ms(pct(durations, 50))}</b><span>p50 latency</span></div>
        <div className="stat-pill"><b>{ms(pct(durations, 95))}</b><span>p95 latency</span></div>
        <div className="stat-pill"><b>{successRate === null ? "—" : `${successRate}%`}</b><span>success rate</span></div>
        <div className="stat-pill"><b>{extracted}</b><span>records extracted</span></div>
      </div>

      <h3 className="ops-h">Recent compile jobs</h3>
      {jobs.length === 0 && <p className="muted">No jobs yet.</p>}
      {jobs.map((j) => (
        <div key={j.id} className="card ops-job">
          <span className={`badge badge-${j.state}`}>{j.state}</span>
          <span className="muted">
            {j.batch_size ?? 0} msg{(j.batch_size ?? 0) === 1 ? "" : "s"} → {j.extracted ?? 0} extracted
          </span>
          <span className="muted">{ms(j.duration_ms)}</span>
          <span className="muted">
            attempt {j.attempts ?? 1}/{j.max_attempts ?? 5}
          </span>
          <span className="muted ops-when">{timeAgo(j.finished_at ?? j.started_at ?? j.created_date)}</span>
          {j.last_error && <p className="ops-err">{j.last_error}</p>}
        </div>
      ))}

      <p className="muted ops-note">
        Every batch ends in <b>done</b> or <b>dead</b> — never silently dropped. A crashed holder is resurrected by the
        reaper once its lease TTL expires; failures back off 30s → 60s → 120s → 240s, then dead-letter.
      </p>
    </div>
  );
}
