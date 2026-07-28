import React, { useEffect, useMemo, useState } from "react";
import { base44, requireUser } from "./api/base44Client.js";
import Board from "./components/Board.jsx";
import LiveFeed from "./components/LiveFeed.jsx";
import Ledger from "./components/Ledger.jsx";
import AskPanel from "./components/AskPanel.jsx";
import EngineRoom from "./components/EngineRoom.jsx";

const TAB_LABELS = { board: "Board", feed: "Live feed", ledger: "Ledger", ask: "Ask the librarian", engine: "Engine Room" };

// Hivemind dashboard — one screen, deliberately thin: its whole job is to make
// the backend visible. Every panel is fed by entity realtime subscriptions.

export default function App() {
  const [user, setUser] = useState(null);
  const [spaces, setSpaces] = useState([]);
  const [spaceId, setSpaceId] = useState(null);
  const [bindState, setBindState] = useState(null); // null | "binding" | "done" | "error"
  const [tab, setTab] = useState("board");
  const [isOwner, setIsOwner] = useState(false); // gates the owner-only Engine Room tab

  // --- auth gate ----------------------------------------------------------
  useEffect(() => {
    requireUser().then(setUser);
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
  const tabs = useMemo(() => ["board", "feed", "ledger", "ask", ...(isOwner ? ["engine"] : [])], [isOwner]);

  if (!user) return <div className="center muted">Signing you in…</div>;

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
        <div className="user muted">{user.email}</div>
      </header>

      {bindState === "binding" && <div className="banner">Claiming your space…</div>}
      {bindState === "error" && <div className="banner error">That invite code didn't work — ask the bot for a fresh link.</div>}

      {!space ? (
        <div className="center">
          <div className="empty">
            <h2>No spaces yet</h2>
            <p>
              Add <b>@HivemindBot</b> to any Telegram group, then open the claim link it posts. The group starts
              compiling instantly — decisions, commitments, questions, events, expenses.
            </p>
          </div>
        </div>
      ) : (
        <>
          <nav className="tabs">
            {tabs.map((t) => (
              <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
                {TAB_LABELS[t]}
              </button>
            ))}
          </nav>
          <main>
            {tab === "board" && <Board spaceId={space.id} />}
            {tab === "feed" && <LiveFeed spaceId={space.id} />}
            {tab === "ledger" && <Ledger spaceId={space.id} />}
            {tab === "ask" && <AskPanel spaceId={space.id} />}
            {tab === "engine" && isOwner && <EngineRoom space={space} />}
          </main>
        </>
      )}

      <footer className="muted">
        Compiled by the Base44 backend — entities · RLS · realtime · functions · automations · agents · AI · storage
      </footer>
    </div>
  );
}
