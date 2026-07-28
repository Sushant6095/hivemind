// weekly-digest — Sunday 18:00 IST (12:30 UTC) scheduled automation, also
// invokable on demand via /digest.
//
// For each space: gather the week's compiled records → InvokeLLM writes a
// narrative digest → GenerateImage paints a "weekly group portrait" from the
// week's vibe → SendEmail to every member + summary posted in the group.
// Exercises AI text, AI image, email and scheduling in one function.

import { createClientFromRequest } from "npm:@base44/sdk";

const TG_API = "https://api.telegram.org/bot";
const WEEK_MS = 7 * 24 * 3600 * 1000;

async function digestSpace(sr: any, token: string | undefined, space: any) {
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const q = { space_id: space.id, created_date: { $gte: since } };

  const [decisions, commitments, questions, events, expenses] = await Promise.all([
    sr.entities.Decision.filter(q, "-created_date", 50),
    sr.entities.Commitment.filter(q, "-created_date", 50),
    sr.entities.Question.filter(q, "-created_date", 50),
    sr.entities.Event.filter(q, "-created_date", 50),
    sr.entities.Expense.filter(q, "-created_date", 50),
  ]);

  const total = decisions.length + commitments.length + questions.length + events.length + expenses.length;
  if (total === 0) return null;

  const spent = expenses.reduce((s: number, x: any) => s + (x.amount ?? 0), 0);
  const stats = {
    decisions: decisions.length,
    commitments: commitments.length,
    open_commitments: commitments.filter((c: any) => c.status !== "done").length,
    questions: questions.length,
    events: events.length,
    expenses: expenses.length,
    spent,
  };

  const narrative: any = await sr.integrations.Core.InvokeLLM({
    prompt:
      `Write a warm, punchy weekly digest (markdown, <200 words) for the group "${space.name}". ` +
      `Data: ${JSON.stringify({ decisions, commitments, events, expenses: { count: expenses.length, spent } })}. ` +
      `Sections: What we decided · Who owes what · Coming up · Money. End with one playful line about the group's week.`,
    model: "gemini_3_flash",
  });
  const content = typeof narrative === "string" ? narrative : JSON.stringify(narrative);

  let cover = "";
  try {
    const img = await sr.integrations.Core.GenerateImage({
      prompt: `Warm flat illustration, weekly portrait of a friend group's week: ${decisions[0]?.title ?? "plans"}, ${events[0]?.title ?? "meetups"}. Cozy, hive/honeycomb motif, no text.`,
    });
    cover = img?.url ?? "";
    if (cover) await sr.entities.Space.update(space.id, { cover_image_url: cover });
  } catch (_) { /* image is a flourish — never fail the digest on it */ }

  const members = await sr.entities.Membership.filter({ space_id: space.id }, undefined, 50);
  const emails = members.map((m: any) => m.user_email).filter(Boolean);
  for (const to of emails) {
    await sr.integrations.Core.SendEmail({
      to,
      subject: `🐝 ${space.name} — your week, compiled`,
      body: `${content}\n\n${cover ? `Weekly portrait: ${cover}\n\n` : ""}Open the board: ${Deno.env.get("APP_PUBLIC_URL") ?? ""}`,
      from_name: "Hivemind",
    }).catch(() => {});
  }

  await sr.entities.Digest.create({
    space_id: space.id,
    period_start: since,
    period_end: new Date().toISOString(),
    content_md: content,
    stats,
    cover_image_url: cover,
    emailed_to: emails,
    member_emails: space.member_emails ?? [],
  });

  if (token && space.tg_chat_id) {
    await fetch(`${TG_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: space.tg_chat_id,
        text: `📬 Weekly digest: ${stats.decisions} decisions · ${stats.open_commitments} open commitments · ₹${spent} tracked. Full story in your inbox.`,
      }),
    }).catch(() => {});
  }

  return stats;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const payload = await req.json().catch(() => ({}));

  const spaces = payload?.space_id
    ? [await sr.entities.Space.get(payload.space_id).catch(() => null)].filter(Boolean)
    : await sr.entities.Space.list(undefined, 100);

  const results: Record<string, unknown> = {};
  for (const space of spaces) {
    results[space.id] = await digestSpace(sr, token, space);
    // analytics: best-effort, never breaks the digest run (only count spaces that actually got one)
    if (results[space.id]) {
      try {
        (base44 as any).analytics?.track({ eventName: "digest_sent", properties: { space_id: space.id } });
      } catch (_) { /* fire-and-forget */ }
    }
  }
  return Response.json({ ok: true, results });
});
