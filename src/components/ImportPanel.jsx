import React, { useState } from "react";
import { base44 } from "../api/base44Client.js";

// ImportPanel — backfill a space from a Telegram Desktop chat export. Uploads
// the JSON to private storage, invokes `import-history`, and subscribes to the
// ImportJob row so the progress bar fills live while the compiler runs.

export default function ImportPanel({ spaceId }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null); // { status, total, done }
  const [result, setResult] = useState(null); // { total, skipped }
  const [err, setErr] = useState(null);

  async function startImport() {
    if (!file || busy) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    setJob({ status: "running", total: 0, done: 0 });

    // Subscribe FIRST: import-history runs synchronously and streams progress
    // onto the ImportJob row while the invoke() call is still pending.
    const unsub = base44.entities.ImportJob.subscribe((event) => {
      const d = event.data;
      if (d?.space_id !== spaceId) return;
      setJob({ status: d.status, total: d.total ?? 0, done: d.done ?? 0 });
    });

    try {
      const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file });
      const res = await base44.functions.invoke("import-history", { space_id: spaceId, file_uri });
      const body = res?.data ?? res ?? {};
      const total = body.total ?? 0;
      setJob({ status: "done", total, done: total });
      setResult({ total, skipped: body.skipped ?? 0 });
    } catch (e) {
      setErr(e?.response?.data?.error ?? "Import failed — make sure the file is a Telegram JSON export.");
      setJob((j) => (j ? { ...j, status: "error" } : { status: "error", total: 0, done: 0 }));
    } finally {
      unsub();
      setBusy(false);
    }
  }

  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const compiling = busy && job?.status === "running";

  return (
    <div className="ask" style={{ maxWidth: 560 }}>
      <div className="card">
        <b>Import a year of chat in one minute</b>
        <p style={{ marginTop: 6 }}>
          The bot only remembers from the moment it joined. Bring the group's <b>past</b>: it replays through the
          same compiler, so old decisions, commitments and questions land on the board.
        </p>
      </div>

      <div className="suggestions" style={{ alignItems: "center" }}>
        <label className="chip" style={{ cursor: busy ? "default" : "pointer" }}>
          {file ? "Choose a different file" : "Choose export .json"}
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              setErr(null);
            }}
          />
        </label>
        {file && <span className="muted" style={{ fontSize: 13 }}>{file.name}</span>}
        <button
          type="button"
          className="chip"
          onClick={startImport}
          disabled={busy || !file}
          style={{ background: "var(--honey)", color: "#14120a", borderColor: "var(--honey)", fontWeight: 600 }}
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>

      {job && (
        <div>
          <div style={{ height: 10, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 999, overflow: "hidden" }}>
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: job.status === "error" ? "var(--red)" : "var(--honey)",
                transition: "width 0.4s ease",
              }}
            />
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            {job.status === "error"
              ? "Import failed."
              : job.total > 0
                ? `Compiled ${job.done} / ${job.total} messages (${pct}%)`
                : "Reading your export…"}
          </div>
        </div>
      )}

      {compiling && (
        <div className="compiler pulsing">
          <span className="dot" /> compiling your history — watch the board fill up
        </div>
      )}

      {result && (
        <div className="banner">
          Imported {result.total} messages{result.skipped ? ` · skipped ${result.skipped} (media / service)` : ""}. Check the Board and Live feed.
        </div>
      )}
      {err && <div className="banner error">{err}</div>}

      <div className="card muted" style={{ fontSize: 13 }}>
        <b style={{ color: "var(--text)" }}>How to export</b>
        <p style={{ marginTop: 6 }}>
          Telegram Desktop → open the group → <b>⋮</b> menu → <b>Export chat history</b> → format <b>JSON</b>,
          media <b>off</b>. Import the resulting <code>result.json</code>.
        </p>
      </div>
    </div>
  );
}
