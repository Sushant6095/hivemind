// research — settle group debates with live internet context.
//
// /research uses InvokeLLM's add_context_from_internet (Google Search/Maps/News
// grounding) and posts a sourced answer back into the group, saving it as an
// answered Question so it becomes part of the compiled memory. Also exposed to
// the librarian agent as a function tool.

import { createClientFromRequest } from "npm:@base44/sdk";

const TG_API = "https://api.telegram.org/bot";

// ── caller authorisation ────────────────────────────────────────────────
// This function spends LLM credits with internet grounding on every call, so
// it cannot be open. telegram-webhook proves itself with the app's shared
// secret; the dashboard proves itself with a session + Membership row.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function authorize(base44: any, sr: any, space_id: string, internal_key?: string) {
  const shared = Deno.env.get("TG_WEBHOOK_SECRET") ?? "";
  if (internal_key && shared && safeEqual(shared, internal_key)) return null;
  const user = await base44.auth.me().catch(() => null);
  if (!user?.email) return Response.json({ error: "auth required" }, { status: 401 });
  const member = await sr.entities.Membership.filter({ space_id, user_email: user.email }, undefined, 1);
  if (member.length === 0) return Response.json({ error: "not a member of this space" }, { status: 403 });
  return null;
}


const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Direct answer, under 100 words" },
    sources: { type: "array", items: { type: "string" }, description: "Source URLs" }
  },
  required: ["answer"]
};

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const { space_id, query, chat_id, reply_to, internal_key } = await req.json().catch(() => ({}));

  if (!space_id || !query?.trim()) return Response.json({ error: "space_id and query required" }, { status: 400 });

  const denied = await authorize(base44, sr, space_id, internal_key);
  if (denied) return denied;

  const result: any = await sr.integrations.Core.InvokeLLM({
    prompt:
      `Research this question for a group chat and answer decisively with today's live information. ` +
      `Question: ${query}`,
    add_context_from_internet: true,
    response_json_schema: RESEARCH_SCHEMA,
  });

  const space = await sr.entities.Space.get(space_id).catch(() => null);
  await sr.entities.Question.create({
    space_id,
    text: query,
    asked_by: "research",
    status: "answered",
    answer: result?.answer ?? "",
    answered_via: "research",
    sources: result?.sources ?? [],
    member_emails: space?.member_emails ?? [],
  });

  if (token && chat_id) {
    const src = (result?.sources ?? []).slice(0, 3).map((s: string) => `• ${s}`).join("\n");
    await fetch(`${TG_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        reply_to_message_id: reply_to,
        text: `🔎 ${result?.answer ?? "No answer found."}${src ? `\n\nSources:\n${src}` : ""}`,
        disable_web_page_preview: true,
      }),
    }).catch(() => {});
  }

  // analytics: best-effort, never breaks the research path
  try {
    (base44 as any).analytics?.track({
      eventName: "research_run",
      properties: { space_id, sources: (result?.sources ?? []).length },
    });
  } catch (_) { /* fire-and-forget */ }

  return Response.json({ ok: true, ...result });
});
