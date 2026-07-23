// telegram-webhook — public HTTP endpoint Telegram POSTs every group update to.
//
// Responsibilities (keep this function FAST — quick-ack, heavy work happens in
// the process-messages / ingest-media automations):
//   1. Verify Telegram's secret token header (set via scripts/set-webhook.sh).
//   2. Deduplicate by update_id (Telegram retries until it gets a 200).
//   3. Handle slash commands (/start /link /ask /research /done /digest).
//   4. Persist everything else as a RawMessage row → entity automation fires.
//
// Uses asServiceRole: webhook calls carry no Base44 user context.

import { createClientFromRequest } from "npm:@base44/sdk";

const TG_API = "https://api.telegram.org/bot";

async function tgSend(chatId: string | number, text: string, replyTo?: number) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;
  await fetch(`${TG_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_to_message_id: replyTo,
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}

function inviteCode() {
  return crypto.randomUUID().split("-")[0];
}

Deno.serve(async (req: Request) => {
  // --- 1. verify secret ---------------------------------------------------
  const secret = Deno.env.get("TG_WEBHOOK_SECRET");
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const msg = update.message ?? update.edited_message;
  if (!msg?.chat) return Response.json({ ok: true }); // ignore other update kinds in v1

  const chatId = String(msg.chat.id);
  const updateId = String(update.update_id ?? "");

  // --- 2. dedup -----------------------------------------------------------
  if (updateId) {
    const dupes = await sr.entities.RawMessage.filter({ tg_update_id: updateId }, undefined, 1);
    if (dupes.length > 0) return Response.json({ ok: true, dedup: true });
  }

  // --- resolve / lazily create the Space for this chat ---------------------
  let [space] = await sr.entities.Space.filter({ tg_chat_id: chatId }, undefined, 1);
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (!space && isGroup) {
    space = await sr.entities.Space.create({
      name: msg.chat.title ?? "Untitled space",
      tg_chat_id: chatId,
      tg_chat_title: msg.chat.title ?? "",
      invite_code: inviteCode(),
      member_emails: [],
      timezone: "Asia/Kolkata",
      stats: { messages_seen: 0 },
    });
    const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "";
    await tgSend(
      chatId,
      `🐝 *Hivemind is now compiling this group.*\n` +
        `Decisions, commitments, questions, events and expenses will be captured automatically — just chat normally.\n\n` +
        `Owner: claim the dashboard → ${appUrl}?bind=${space.invite_code}\n` +
        `Commands: /ask · /research · /done · /digest`,
    );
  }
  if (!space) return Response.json({ ok: true }); // DMs not supported in v1

  const text: string = msg.text ?? msg.caption ?? "";
  const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Someone";

  // --- 3. commands --------------------------------------------------------
  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(" ");
    const arg = rest.join(" ").trim();
    const bare = cmd.split("@")[0]; // "/ask@HivemindBot" → "/ask"

    if (bare === "/start" || bare === "/help") {
      await tgSend(chatId, "🐝 I silently compile this chat into a live database. Try /ask, /research, /done, /digest.");
    } else if (bare === "/ask") {
      // Answer from the group's compiled memory (librarian) — async self-invoke.
      await base44.functions.invoke("ask", { space_id: space.id, question: arg, chat_id: chatId, reply_to: msg.message_id });
    } else if (bare === "/research") {
      await base44.functions.invoke("research", { space_id: space.id, query: arg, chat_id: chatId, reply_to: msg.message_id });
    } else if (bare === "/done") {
      await base44.functions.invoke("mark-done", { space_id: space.id, needle: arg, chat_id: chatId, by_name: senderName });
    } else if (bare === "/digest") {
      await base44.functions.invoke("weekly-digest", { space_id: space.id, on_demand: true });
      await tgSend(chatId, "📬 Compiling your digest — it will arrive here and by email.");
    }
    return Response.json({ ok: true });
  }

  // --- 4. persist as RawMessage → automations take over --------------------
  const media = msg.photo?.length
    ? { media_type: "photo", tg_file_id: msg.photo.at(-1).file_id }
    : msg.document
      ? { media_type: "document", tg_file_id: msg.document.file_id }
      : msg.voice
        ? { media_type: "voice", tg_file_id: msg.voice.file_id }
        : { media_type: "none" };

  await sr.entities.RawMessage.create({
    space_id: space.id,
    tg_update_id: updateId,
    tg_message_id: String(msg.message_id),
    sender_tg_id: String(msg.from?.id ?? ""),
    sender_name: senderName,
    text,
    ...media,
    sent_at: new Date((msg.date ?? Date.now() / 1000) * 1000).toISOString(),
    processed: false,
    member_emails: space.member_emails ?? [],
  });

  await sr.entities.Space.update(space.id, {
    stats: { ...(space.stats ?? {}), messages_seen: ((space.stats?.messages_seen ?? 0) as number) + 1 },
  });

  return Response.json({ ok: true });
});
