import React, { useEffect, useState } from "react";
import { base44 } from "../api/base44Client.js";

// ApiKeysPanel — owner-only. Mint/revoke keys for the headless read API
// (base44/functions/api). Non-owners get a read-only notice; the raw key
// value is shown once, at generation time.

const API_PATH = "/functions/api";

export default function ApiKeysPanel({ spaceId }) {
  const [role, setRole] = useState(null); // null | "owner" | "member"
  const [keys, setKeys] = useState([]);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState(null); // { id, key } shown once after generate
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function loadRole() {
    const user = await base44.auth.me().catch(() => null);
    if (!user?.email) return setRole("member");
    const rows = await base44.entities.Membership.filter({ space_id: spaceId, user_email: user.email }, undefined, 1);
    setRole(rows[0]?.role ?? "member");
  }

  function loadKeys() {
    base44.entities.ApiKey.filter({ space_id: spaceId }, "-created_date", 50).then(setKeys).catch(() => setKeys([]));
  }

  useEffect(() => {
    setFresh(null);
    setRole(null);
    loadRole();
    loadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("api", { action: "generate", space_id: spaceId, label });
      const out = res?.data ?? res;
      setFresh({ id: out.id, key: out.key });
      setLabel("");
      loadKeys();
    } catch (e) {
      setError(e?.response?.data?.error ?? "Could not generate a key.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(keyId) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await base44.functions.invoke("api", { action: "revoke", space_id: spaceId, key_id: keyId });
      if (fresh?.id === keyId) setFresh(null);
      loadKeys();
    } catch (e) {
      setError(e?.response?.data?.error ?? "Could not revoke that key.");
    } finally {
      setBusy(false);
    }
  }

  const apiBase = `${window.location.origin}${API_PATH}`;

  return (
    <div className="apikeys">
      <p className="muted">
        A read-only HTTP API over this space's compiled memory. Pass a key as <code>?key=</code> and pick a{" "}
        <code>resource</code>: decisions · commitments · expenses · events · ledger. No app data is ever written through it.
      </p>

      {role === "owner" && (
        <form
          className="key-new"
          onSubmit={(e) => {
            e.preventDefault();
            generate();
          }}
        >
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Zapier, Grafana)…" />
          <button type="submit" disabled={busy}>Generate key</button>
        </form>
      )}
      {role === "member" && <p className="muted">Only the space owner can generate or revoke API keys.</p>}
      {error && <p className="key-err">{error}</p>}

      {fresh && (
        <div className="key-fresh">
          <div className="muted">Copy this now — it isn't shown again:</div>
          <code className="key-value">{fresh.key}</code>
          <div className="key-curl">
            <code>curl "{apiBase}?key={fresh.key}&resource=ledger"</code>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <div className="key-list">
          {keys.map((k) => (
            <div key={k.id} className="key-row">
              <span className="key-label">{k.label || "API key"}</span>
              <code className="key-mask">{fresh?.id === k.id ? fresh.key : maskKey(k.key)}</code>
              {role === "owner" && (
                <button className="mini danger" onClick={() => revoke(k.id)} disabled={busy}>Revoke</button>
              )}
            </div>
          ))}
        </div>
      )}
      {keys.length === 0 && role && <p className="muted">No keys yet.</p>}
    </div>
  );
}

// Show the prefix + last 4 so owners can identify a key without exposing it.
function maskKey(key = "") {
  if (key.length <= 12) return "hmk_••••";
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}
