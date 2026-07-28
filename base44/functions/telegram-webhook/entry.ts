// telegram-webhook — public HTTP endpoint Telegram POSTs every group update to.
//
// Responsibilities (keep this function FAST — quick-ack, heavy work runs in the
// process-messages / ingest-media functions, invoked fire-and-forget below):
//   1. Verify Telegram's secret token header (set via scripts/set-webhook.sh).
//   2. Deduplicate by update_id (Telegram retries until it gets a 200).
//   3. Handle slash commands (/start /link /ask /research /done /digest).
//   4. Persist everything else as a RawMessage row → invoke the compiler chain.
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

// Constant-time compare — a plain !== leaks the secret's length and, in
// principle, its prefix through response timing.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Replay window. Deliberately generous: a tight window plus clock skew — or
// Telegram redelivering a backlog when the bot is re-added — would make the bot
// look dead. One hour defends replay without any chance of biting a live demo.
const MAX_AGE_S = 3600;

Deno.serve(async (req: Request) => {
  // --- 1. verify secret ---------------------------------------------------
  const secret = Deno.env.get("TG_WEBHOOK_SECRET");
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (secret && !safeEqual(secret, got)) {
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

  // Replay defence: ack (so Telegram stops retrying) but refuse to process.
  if (msg.date && Date.now() / 1000 - Number(msg.date) > MAX_AGE_S) {
    return Response.json({ ok: true, skipped: "stale" });
  }

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

  // --- 4. persist as RawMessage → invoke the compiler chain ----------------
  // This app runs the Workflows runtime, so legacy entity automations are off.
  // We invoke the pipeline explicitly and do NOT await it — keep the webhook a
  // quick-ack (Telegram retries on slow responses).
  const media = msg.photo?.length
    ? { media_type: "photo", tg_file_id: msg.photo.at(-1).file_id }
    : msg.document
      ? { media_type: "document", tg_file_id: msg.document.file_id }
      : msg.voice
        ? { media_type: "voice", tg_file_id: msg.voice.file_id }
        : { media_type: "none" };

  const raw = await sr.entities.RawMessage.create({
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

  // Collapse concurrent retries. The tg_update_id filter above is a fast path
  // that catches the overwhelming majority (retries arrive seconds apart), but
  // it is check-then-act: two overlapping deliveries of the same update can both
  // pass it. Oldest row for this update_id wins; a loser deletes itself.
  if (updateId) {
    const sameUpdate = await sr.entities.RawMessage.filter({ tg_update_id: updateId }, "created_date", 5);
    if (sameUpdate.length > 1 && sameUpdate[0].id !== raw.id) {
      await sr.entities.RawMessage.delete(raw.id).catch(() => {});
      return Response.json({ ok: true, dedup: "raced" });
    }
  }

  await sr.entities.Space.update(space.id, {
    stats: { ...(space.stats ?? {}), messages_seen: ((space.stats?.messages_seen ?? 0) as number) + 1 },
  });

  // Fire-and-forget the compiler pass (debounces bursts internally). For media
  // messages, also fire the receipt/media pipeline with the created record.
  base44.functions.invoke("process-messages", { space_id: space.id }).catch(() => {});
  if (media.media_type !== "none") {
    base44.functions.invoke("ingest-media", { data: raw }).catch(() => {});
  }

  return Response.json({ ok: true });
});
