// ask — the librarian: total-recall Q&A over the group's compiled memory.
//
// Invoked from /ask in Telegram (via telegram-webhook) or the dashboard panel.
// Grounds a strong model (claude_sonnet_4_6) on the space's compiled entities
// and answers WITH PROVENANCE. The same knowledge is exposed to the configured
// Base44 agent (base44/agents/librarian.jsonc) for dashboard conversations —
// this function is the deterministic path used by the bot.

import { createClientFromRequest } from "npm:@base44/sdk";

const TG_API = "https://api.telegram.org/bot";

// ── caller authorisation ────────────────────────────────────────────────
// Two legitimate callers, and they prove themselves differently:
//   • the dashboard — a signed-in user, checked against Membership;
//   • telegram-webhook — server-to-server, which carries no user session, so
//     it presents the app's shared webhook secret as internal_key.
// Anything else is anonymous and gets 401. This used to read
// `if (user?.email) { ...check membership... }`, which meant an unauthenticated
// caller skipped the check entirely and could act on any space by id.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function authorize(base44: any, sr: any, space_id: string, internal_key?: string) {
  const shared = Deno.env.get("TG_WEBHOOK_SECRET") ?? "";
  if (internal_key && shared && safeEqual(shared, internal_key)) return null; // trusted server-to-server
  const user = await base44.auth.me().catch(() => null);
  if (!user?.email) return Response.json({ error: "auth required" }, { status: 401 });
  const member = await sr.entities.Membership.filter({ space_id, user_email: user.email }, undefined, 1);
  if (member.length === 0) return Response.json({ error: "not a member of this space" }, { status: 403 });
  return null;
}


// ── BM25 lexical retrieval ──────────────────────────────────────────────
// Okapi BM25, implemented in place: no embedding round-trip, no vector store,
// deterministic and sub-millisecond at group scale. Replaces serialising all
// ~210 compiled rows into every prompt, which neither scales nor grounds well.
const STOP = new Set(
  "a an the is are was were be been to of in on for and or we i you it that this at by with about our us".split(" "),
);
const tok = (s: string) =>
  ((s ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

function bm25(query: string, docs: { id: string; text: string; meta?: any }[], k = 8) {
  const q = [...new Set(tok(query))];
  if (!q.length || !docs.length) return [];
  const D = docs.map((d) => ({ ...d, terms: tok(d.text) }));
  const avgdl = D.reduce((s, d) => s + d.terms.length, 0) / D.length || 1;
  const df: Record<string, number> = {};
  for (const d of D) for (const t of new Set(d.terms)) df[t] = (df[t] ?? 0) + 1;
  const K1 = 1.5, B = 0.75;
  return D.map((d) => {
    const tf: Record<string, number> = {};
    for (const t of d.terms) tf[t] = (tf[t] ?? 0) + 1;
    let score = 0;
    for (const t of q) {
      if (!tf[t]) continue;
      const idf = Math.log(1 + (D.length - (df[t] ?? 0) + 0.5) / ((df[t] ?? 0) + 0.5));
      score += idf * (tf[t] * (K1 + 1)) / (tf[t] + K1 * (1 - B + B * (d.terms.length / avgdl)));
    }
    return { id: d.id, text: d.text, meta: d.meta, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

async function tgSend(chatId: string | number, text: string, replyTo?: number) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token || !chatId) return;
  await fetch(`${TG_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_to_message_id: replyTo, disable_web_page_preview: true }),
  }).catch(() => {});
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const { space_id, question, chat_id, reply_to, internal_key } = await req.json().catch(() => ({}));

  if (!space_id || !question?.trim()) {
    if (chat_id) await tgSend(chat_id, "Usage: /ask what did we decide about …?", reply_to);
    return Response.json({ error: "space_id and question required" }, { status: 400 });
  }

  const denied = await authorize(base44, sr, space_id, internal_key);
  if (denied) return denied;

  // --- assemble the space's compiled memory --------------------------------
  const [decisions, commitments, questions, events, expenses] = await Promise.all([
    sr.entities.Decision.filter({ space_id }, "-created_date", 50),
    sr.entities.Commitment.filter({ space_id }, "-created_date", 50),
    sr.entities.Question.filter({ space_id }, "-created_date", 30),
    sr.entities.Event.filter({ space_id }, "-created_date", 30),
    sr.entities.Expense.filter({ space_id }, "-created_date", 50),
  ]);

  // --- retrieval: rank, don't dump ----------------------------------------
  // One flat doc list, BM25-ranked against the question. Active decisions and
  // open commitments are ALWAYS force-included, so "what's pending on me?" still
  // works when it shares no vocabulary with any stored row.
  const docs = [
    ...decisions.map((d: any) => ({ id: d.id, text: `decision: ${d.title} ${d.detail ?? ""}`, meta: { type: "decision", title: d.title, status: d.status, when: d.decided_at, src: d.source_msg_ids } })),
    ...commitments.map((c: any) => ({ id: c.id, text: `commitment: ${c.who_name} will ${c.what}`, meta: { type: "commitment", title: c.what, who: c.who_name, due: c.due_at, status: c.status, src: c.source_msg_ids } })),
    ...questions.map((q: any) => ({ id: q.id, text: `question: ${q.text} ${q.answer ?? ""}`, meta: { type: "question", title: q.text, status: q.status, answer: q.answer, src: q.source_msg_ids } })),
    ...events.map((v: any) => ({ id: v.id, text: `event: ${v.title} ${v.location ?? ""}`, meta: { type: "event", title: v.title, when: v.starts_at, where: v.location, src: v.source_msg_ids } })),
    ...expenses.map((x: any) => ({ id: x.id, text: `expense: ${x.payer_name} paid ${x.amount} ${x.currency} for ${x.description}`, meta: { type: "expense", title: x.description, payer: x.payer_name, amount: x.amount, currency: x.currency, src: x.source_msg_ids } })),
  ];

  const ranked = bm25(question, docs, 12);
  const always = docs
    .filter((d) => (d.meta.type === "decision" && d.meta.status === "active") || d.meta.type === "commitment")
    .slice(0, 12);
  const chosen = [...new Map([...ranked, ...always].map((d) => [d.id, d])).values()];

  const memory = JSON.stringify(chosen.map((d) => ({ ref: d.id, ...d.meta })));

  const answer: any = await sr.integrations.Core.InvokeLLM({
    prompt:
      `You are the librarian of a group chat with total recall. Answer the member's question ` +
      `STRICTLY from the compiled memory JSON below. Quote who/what/when precisely. If the memory ` +
      `doesn't contain the answer, say so plainly and suggest /research for factual/external questions. ` +
      `Keep it under 120 words, plain text for Telegram.\n\nCOMPILED MEMORY:\n${memory}\n\nQUESTION: ${question}`,
    model: "claude_sonnet_4_6",
  });

  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  if (chat_id) await tgSend(chat_id, `🐝 ${text}`, reply_to);

  // analytics: best-effort, never breaks the answer path
  try {
    (base44 as any).analytics?.track({
      eventName: "ask_answered",
      properties: { space_id, via: chat_id ? "telegram" : "dashboard" },
    });
  } catch (_) { /* fire-and-forget */ }

  // Citations close the provenance loop: the dashboard can render each one as a
  // chip that opens the same Provenance drawer the board cards use.
  return Response.json({
    ok: true,
    answer: text,
    citations: chosen.slice(0, 6).map((d) => ({
      id: d.id,
      type: d.meta.type,
      title: d.meta.title,
      source_msg_ids: d.meta.src ?? [],
    })),
    retrieval: { candidates: docs.length, selected: chosen.length, method: "bm25" },
  });
});
