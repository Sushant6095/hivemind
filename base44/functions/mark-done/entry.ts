// mark-done — close a commitment from chat (/done <keyword>) or the dashboard.

import { createClientFromRequest } from "npm:@base44/sdk";

const TG_API = "https://api.telegram.org/bot";

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const { space_id, needle, commitment_id, chat_id, by_name } = await req.json().catch(() => ({}));

  // Dashboard path: authed member closes a specific commitment.
  const user = await base44.auth.me().catch(() => null);
  if (commitment_id) {
    if (!user?.email) return Response.json({ error: "auth required" }, { status: 401 });
    const member = await sr.entities.Membership.filter({ space_id, user_email: user.email }, undefined, 1);
    if (member.length === 0) return Response.json({ error: "not a member" }, { status: 403 });
    await sr.entities.Commitment.update(commitment_id, { status: "done" });
    return Response.json({ ok: true });
  }

  // Chat path: fuzzy-match the freshest open commitment containing the keyword.
  if (!space_id || !needle?.trim()) return Response.json({ error: "needle required" }, { status: 400 });
  const open = await sr.entities.Commitment.filter({ space_id, status: { $in: ["open", "overdue"] } }, "-created_date", 100);
  const n = needle.toLowerCase();
  const hit = open.find((c: any) => `${c.who_name} ${c.what}`.toLowerCase().includes(n));

  if (hit) {
    await sr.entities.Commitment.update(hit.id, { status: "done" });
    if (token && chat_id) {
      await fetch(`${TG_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id, text: `✅ Done: ${hit.who_name} — ${hit.what}${by_name ? ` (closed by ${by_name})` : ""}` }),
      }).catch(() => {});
    }
    return Response.json({ ok: true, closed: hit.id });
  }

  if (token && chat_id) {
    await fetch(`${TG_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text: `🤔 No open commitment matches "${needle}".` }),
    }).catch(() => {});
  }
  return Response.json({ ok: false, closed: null });
});
