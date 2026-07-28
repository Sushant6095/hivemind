// mark-done — close a commitment from chat (/done <keyword>) or the dashboard.

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


Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const { space_id, needle, commitment_id, chat_id, by_name, internal_key } = await req.json().catch(() => ({}));

  // Both paths mutate, so both are gated. The chat path used to be wide open:
  // any anonymous caller could close any commitment in any space by id.
  const denied = await authorize(base44, sr, space_id, internal_key);
  if (denied) return denied;

  // Dashboard path: close one specific commitment.
  if (commitment_id) {
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
