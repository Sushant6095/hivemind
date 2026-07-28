import React, { useEffect, useMemo, useState } from "react";
import { base44, getUser, signIn } from "./api/base44Client.js";
import Board from "./components/Board.jsx";
import LiveFeed from "./components/LiveFeed.jsx";
import Ledger from "./components/Ledger.jsx";
import AskPanel from "./components/AskPanel.jsx";
import ImportPanel from "./components/ImportPanel.jsx";
import Digest from "./components/Digest.jsx";
import StatsHeader from "./components/StatsHeader.jsx";
import ToastHost from "./components/ToastHost.jsx";
import ApiKeysPanel from "./components/ApiKeysPanel.jsx";
import OpsPanel from "./components/OpsPanel.jsx";
import EngineRoom from "./components/EngineRoom.jsx";

const TAB_LABELS = {
  board: "Board",
  feed: "Live feed",
  ledger: "Ledger",
  digest: "Digest",
  ask: "Ask the librarian",
  import: "Import",
  api: "API",
  ops: "Ops",
  engine: "Engine Room",
};

// Hivemind dashboard — one screen, deliberately thin: its whole job is to make
// the backend visible. Every panel is fed by entity realtime subscriptions.

// ?panel=1 → embedded (Chrome side panel) mode: chrome hidden, defaults to feed.
const panelMode = new URLSearchParams(window.location.search).has("panel");

export default function App() {
  const [user, setUser] = useState(null);
  const [spaces, setSpaces] = useState([]);
  const [spaceId, setSpaceId] = useState(null);
  const [bindState, setBindState] = useState(null); // null | "binding" | "done" | "error"
  const [tab, setTab] = useState(panelMode ? "feed" : "board");
  const [isOwner, setIsOwner] = useState(false); // gates the owner-only Engine Room tab
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (panelMode) document.body.classList.add("panel-mode");
  }, []);

  // --- auth gate ----------------------------------------------------------
  // Resolve, never redirect: an automatic bounce to a login wall would be the
  // worst possible first frame (and, with a relative /login, an infinite loop).
  useEffect(() => {
    let cancelled = false;
    getUser().then((u) => {
      if (cancelled) return;
      setUser(u);
      setAuthChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- ?bind=CODE claim flow ---------------------------------------------
  useEffect(() => {
    if (!user) return;
    const code = new URLSearchParams(window.location.search).get("bind");
    if (!code) return;
    setBindState("binding");
    base44.functions
      .invoke("bind-space", { invite_code: code })
      .then(() => {
        setBindState("done");
        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch(() => setBindState("error"));
  }, [user]);

  // --- spaces (RLS means we only ever see our own) ------------------------
  useEffect(() => {
    if (!user || bindState === "binding") return;
    let cancelled = false;
    base44.entities.Space.list("-updated_date", 50).then((rows) => {
      if (cancelled) return;
      setSpaces(rows);
      setSpaceId((cur) => cur ?? rows[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [user, bindState]);

  // --- owner check drives the Engine Room tab (Membership.role === "owner") --
  useEffect(() => {
    if (!user || !spaceId) {
      setIsOwner(false);
      return;
    }
    let cancelled = false;
    base44.entities.Membership.filter({ space_id: spaceId, user_email: user.email }, undefined, 1)
      .then((rows) => {
        if (cancelled) return;
        const owner = rows?.[0]?.role === "owner";
        setIsOwner(owner);
        if (!owner) setTab((t) => (t === "engine" ? "board" : t));
      })
      .catch(() => !cancelled && setIsOwner(false));
    return () => {
      cancelled = true;
    };
  }, [user, spaceId]);

  const space = useMemo(() => spaces.find((s) => s.id === spaceId), [spaces, spaceId]);
  const tabs = useMemo(
    () => ["board", "feed", "ledger", "digest", "ask", "import", "api", "ops", ...(isOwner ? ["engine"] : [])],
    [isOwner],
  );

  if (!authChecked) return <div className="center muted">Loading…</div>;

  if (!user) {
    const code = new URLSearchParams(window.location.search).get("bind");
    return (
      <div className="center">
        <div className="empty">
          <h2><span className="logo">🐝</span> Hivemind</h2>
          <p className="tag">your group chat, compiled</p>
          <p>
            Add one bot to a Telegram group and the conversation compiles itself
            into a live database — decisions, commitments, questions, events and
            expenses, each one traced back to the message it came from.
          </p>
          <p>
            {code
              ? "Sign in to claim your space and open the dashboard."
              : "Sign in to open your dashboard, or take the tour first."}
          </p>
          <div className="row">
            <button className="tab active" onClick={() => signIn()}>Sign in with Base44</button>
            <a className="chip" href="/landing.html">Take the tour</a>
            <a
              className="chip"
              href="https://github.com/Sushant6095/hivemind#readme"
              target="_blank"
              rel="noreferrer"
            >
              Engineering docs ↗
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">🐝</span>
          <div>
            <h1>Hivemind</h1>
            <p className="tag">your group chat, compiled</p>
          </div>
        </div>
        <div className="spaces">
          {spaces.map((s) => (
            <button key={s.id} className={s.id === spaceId ? "chip active" : "chip"} onClick={() => setSpaceId(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
        <span className="live-badge"><span className="live-dot" /> live</span>
        <div className="user muted" title={user.email}>{user.email}</div>
      </header>

      {bindState === "binding" && <div className="banner">Claiming your space…</div>}
      {bindState === "error" && <div className="banner error">That invite code didn't work — ask the bot for a fresh link.</div>}

      {!space ? (
        <div className="center">
          <div className="empty">
            <h2>No spaces yet</h2>
            <p>
              Add <b>@base44hive_bot</b> to any Telegram group, then open the claim link it posts. The group starts
              compiling instantly — decisions, commitments, questions, events, expenses.
            </p>
          </div>
        </div>
      ) : (
        <>
          <StatsHeader space={space} />
          <nav className="tabs">
            {tabs.map((t) => (
              <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
                {TAB_LABELS[t]}
              </button>
            ))}
          </nav>
          <main>
            {tab === "board" && <Board space={space} />}
            {tab === "feed" && <LiveFeed spaceId={space.id} />}
            {tab === "ledger" && <Ledger spaceId={space.id} />}
            {tab === "digest" && <Digest spaceId={space.id} />}
            {tab === "ask" && <AskPanel spaceId={space.id} />}
            {tab === "import" && <ImportPanel spaceId={space.id} />}
            {tab === "api" && <ApiKeysPanel spaceId={space.id} />}
            {tab === "ops" && <OpsPanel spaceId={space.id} />}
            {tab === "engine" && isOwner && <EngineRoom space={space} />}
          </main>
        </>
      )}

      <footer className="muted">
        Compiled by the Base44 backend — entities · RLS · realtime · functions · automations · agents · AI · storage
      </footer>
      <ToastHost />
    </div>
  );
}
