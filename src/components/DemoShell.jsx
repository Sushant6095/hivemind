import React, { useEffect, useMemo, useState } from "react";
import { base44, signIn } from "../api/base44Client.js";
import { SourceProvider, demoSource } from "../api/source.jsx";
import Board from "./Board.jsx";
import LiveFeed from "./LiveFeed.jsx";
import StatsHeader from "./StatsHeader.jsx";

// DemoShell — what a first-time visitor sees instead of a login wall.
//
// The pitch is "chat goes in, a structured database comes out", and that is not
// a claim you can win on by describing it. So the anonymous landing state is the
// product: a real seeded Telegram group, already compiled, with every card
// opening the same Provenance drawer a paying user gets. Same components, same
// rendering path — only the data source differs (see api/source.jsx).
//
// Everything here is read-only and comes from the public `demo` function, which
// resolves its own space and ignores caller input, so nothing about this path
// widens access to anybody's real group.

const TABS = { board: "Board", feed: "Live feed", chat: "The chat it read" };

// The raw conversation, shown beside the board so the transformation is legible
// at a glance rather than asserted. Newest last, the way you'd read a chat.
function ChatLog({ messages }) {
  const ordered = [...(messages ?? [])].sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
  return (
    <div className="feed">
      <div className="compiler">
        <span className="dot" /> {ordered.length} messages went in — the Board is what came out
      </div>
      {ordered.map((m) => (
        <div key={m.id} className="feed-item">
          <span className="icon">💬</span>
          <span className="text"><b>{m.sender_name || "someone"}</b> {m.text}</span>
          <span className="when muted">#{m.tg_message_id}</span>
        </div>
      ))}
    </div>
  );
}

export default function DemoShell({ onUnavailable }) {
  const [snap, setSnap] = useState(null); // null = loading
  const [tab, setTab] = useState("board");

  useEffect(() => {
    let cancelled = false;
    base44.functions
      .invoke("demo", {})
      .then((res) => {
        const body = res?.data ?? res; // invoke may return the raw axios response
        if (cancelled) return;
        if (!body?.ok || !body?.space) throw new Error("no demo");
        setSnap(body);
      })
      .catch(() => !cancelled && onUnavailable?.());
    return () => {
      cancelled = true;
    };
  }, [onUnavailable]);

  if (!snap) return <div className="center muted">Loading a real compiled group…</div>;
  return <DemoDashboard snap={snap} tab={tab} setTab={setTab} />;
}

// Split out so the source can be memoised on `snap`. A source rebuilt on every
// render would change identity every render, and the panels key their load
// effects on it — that is an infinite render loop, not a performance nit.
function DemoDashboard({ snap, tab, setTab }) {
  const source = useMemo(() => demoSource(snap), [snap]);
  const space = snap.space;

  return (
    <SourceProvider source={source}>
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
            <span className="chip active">{space.name}</span>
          </div>
          <span className="live-badge"><span className="live-dot" /> live demo</span>
          <div className="demo-actions">
            <a className="chip" href="/landing.html">Take the tour</a>
            <button className="tab active" onClick={() => signIn()}>Sign in</button>
          </div>
        </header>

        <div className="banner">
          <b>You're looking at a real Telegram group after Hivemind read it.</b>{" "}
          {snap.counts?.messages ?? 0} messages of ordinary chat went in; these{" "}
          {snap.counts?.compiled ?? 0} rows came out — decisions, commitments, questions, events and
          expenses. Click any card to see the exact messages it was compiled from. No sign-in needed.
        </div>

        <StatsHeader space={space} />
        <nav className="tabs">
          {Object.entries(TABS).map(([k, label]) => (
            <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
        <main>
          {tab === "board" && <Board space={space} />}
          {tab === "feed" && <LiveFeed spaceId={space.id} />}
          {tab === "chat" && <ChatLog messages={snap.RawMessage} />}
        </main>

        <footer className="muted">
          Read-only demo · the signed-in dashboard adds realtime, Ask the librarian (BM25 retrieval
          with citations), a ledger, digests, an API and the Engine Room —{" "}
          <button className="linklike" onClick={() => signIn()}>sign in</button> to see it.
        </footer>
      </div>
    </SourceProvider>
  );
}
