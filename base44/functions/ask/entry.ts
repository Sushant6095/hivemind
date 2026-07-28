// ask — the librarian: total-recall Q&A over the group's compiled memory.
//
// Invoked from /ask in Telegram (via telegram-webhook) or the dashboard panel.
// Grounds a strong model (claude_sonnet_4_6) on the space's compiled entities
// and answers WITH PROVENANCE. The same knowledge is exposed to the configured
// Base44 agent (base44/agents/librarian.jsonc) for dashboard conversations —
// this function is the deterministic path used by the bot.

import { createClientFromRequest } from "npm:@base44/sdk";

const TG_API = "https://api.telegram.org/bot";

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
  const { space_id, question, chat_id, reply_to } = await req.json().catch(() => ({}));

  if (!space_id || !question?.trim()) {
    if (chat_id) await tgSend(chat_id, "Usage: /ask what did we decide about …?", reply_to);
    return Response.json({ error: "space_id and question required" }, { status: 400 });
  }

  // If called from the dashboard (authed user), enforce membership.
  const user = await base44.auth.me().catch(() => null);
  if (user?.email) {
    const member = await sr.entities.Membership.filter({ space_id, user_email: user.email }, undefined, 1);
    if (member.length === 0) return Response.json({ error: "not a member of this space" }, { status: 403 });
  }

  // --- assemble the space's compiled memory --------------------------------
  const [decisions, commitments, questions, events, expenses] = await Promise.all([
    sr.entities.Decision.filter({ space_id }, "-created_date", 50),
    sr.entities.Commitment.filter({ space_id }, "-created_date", 50),
    sr.entities.Question.filter({ space_id }, "-created_date", 30),
    sr.entities.Event.filter({ space_id }, "-created_date", 30),
    sr.entities.Expense.filter({ space_id }, "-created_date", 50),
  ]);

  const memory = JSON.stringify({
    decisions: decisions.map((d: any) => ({ title: d.title, detail: d.detail, status: d.status, decided_at: d.decided_at, src: d.source_msg_ids })),
    commitments: commitments.map((c: any) => ({ who: c.who_name, what: c.what, due: c.due_at, status: c.status, src: c.source_msg_ids })),
    open_questions: questions.filter((q: any) => q.status === "open").map((q: any) => q.text),
    answered_questions: questions.filter((q: any) => q.status === "answered").map((q: any) => ({ q: q.text, a: q.answer })),
    events: events.map((e: any) => ({ title: e.title, when: e.starts_at, where: e.location })),
    expenses: expenses.map((x: any) => ({ payer: x.payer_name, amount: x.amount, currency: x.currency, what: x.description })),
  });

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

  return Response.json({ ok: true, answer: text });
});
