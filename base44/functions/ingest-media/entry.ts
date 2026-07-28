// ingest-media — entity automation on RawMessage(create) for media messages.
//
// Downloads the file from Telegram, stores it in PRIVATE Base44 storage, and —
// when it looks like a receipt/bill — runs ExtractDataFromUploadedFile to turn
// the photo into an itemized Expense with an even split across members.
// (Storage capability + document-AI capability in one pipeline.)

import { createClientFromRequest } from "npm:@base44/sdk";

const TG_API = "https://api.telegram.org/bot";

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    is_receipt: { type: "boolean", description: "true only if this is a bill/receipt/invoice" },
    merchant: { type: "string" },
    total_amount: { type: "number" },
    currency: { type: "string" },
    items: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, price: { type: "number" } } }
    }
  },
  required: ["is_receipt"]
};

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");

  const payload = await req.json().catch(() => ({}));
  const raw = payload?.data;
  if (!raw?.id || raw.media_type === "none" || !raw.tg_file_id || !token) {
    return Response.json({ ok: true, skipped: true });
  }

  // --- download from Telegram ---------------------------------------------
  const info = await fetch(`${TG_API}${token}/getFile?file_id=${raw.tg_file_id}`).then((r) => r.json());
  const path = info?.result?.file_path;
  if (!path) return Response.json({ ok: false, error: "getFile failed" });

  const bytes = await fetch(`https://api.telegram.org/file/bot${token}/${path}`).then((r) => r.arrayBuffer());
  const filename = path.split("/").pop() ?? "upload.bin";
  const file = new File([bytes], filename);

  // --- private storage -----------------------------------------------------
  const { file_uri } = await sr.integrations.Core.UploadPrivateFile({ file });
  await sr.entities.RawMessage.update(raw.id, { media_file_uri: file_uri, processed: raw.media_type !== "photo" });

  // --- receipts → itemized Expense -----------------------------------------
  if (raw.media_type === "photo" || filename.toLowerCase().endsWith(".pdf")) {
    const { signed_url } = await sr.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 600 });
    const data: any = await sr.integrations.Core.ExtractDataFromUploadedFile({
      file_url: signed_url,
      json_schema: RECEIPT_SCHEMA,
    }).catch(() => null);

    const extracted = data?.output ?? data;
    if (extracted?.is_receipt && extracted?.total_amount) {
      const space = await sr.entities.Space.get(raw.space_id).catch(() => null);
      const members = await sr.entities.Membership.filter({ space_id: raw.space_id }, undefined, 20);
      const names = members.map((m: any) => m.tg_display_name || m.user_email);
      const share = names.length ? Math.round((extracted.total_amount / names.length) * 100) / 100 : extracted.total_amount;

      await sr.entities.Expense.create({
        space_id: raw.space_id,
        payer_name: raw.sender_name,
        amount: extracted.total_amount,
        currency: extracted.currency || "INR",
        description: extracted.merchant ? `Receipt — ${extracted.merchant}` : "Receipt",
        items: extracted.items ?? [],
        split: names.map((n: string) => ({ name: n, share })),
        receipt_file_uri: file_uri,
        source_msg_ids: [raw.tg_message_id],
        member_emails: space?.member_emails ?? [],
      });

      await fetch(`${TG_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: space?.tg_chat_id,
          reply_to_message_id: Number(raw.tg_message_id),
          text: `🧾 Logged ${extracted.currency || "INR"} ${extracted.total_amount}${extracted.merchant ? ` at ${extracted.merchant}` : ""} — split ${names.length} ways on the board.`,
        }),
      }).catch(() => {});

      // analytics: best-effort, never breaks media ingestion
      try {
        (base44 as any).analytics?.track({
          eventName: "receipt_parsed",
          properties: { space_id: raw.space_id, amount: extracted.total_amount, currency: extracted.currency || "INR" },
        });
      } catch (_) { /* fire-and-forget */ }
    }
    await sr.entities.RawMessage.update(raw.id, { processed: true });
  }

  return Response.json({ ok: true });
});
