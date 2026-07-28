// import-history — backfill a space from a Telegram Desktop chat export.
//
// The bot only sees messages from the moment it's added. This function imports
// the group's PAST: a member exports the chat (Telegram Desktop → Export chat
// history → JSON, media off), the dashboard uploads it to private storage, and
// this function replays the text messages through the REAL compiler pass so a
// year of history lands on the board as decisions/commitments/questions/etc.
//
// Progress is written to an ImportJob row that the dashboard subscribes to for
// a live progress bar. All writes are service-role (entities are write-locked
// by RLS); membership is enforced against the space before anything runs.

import { createClientFromRequest } from "npm:@base44/sdk";

const MESSAGE_CAP = 2000; // hard ceiling on messages imported in one run

/** Telegram export `text` is a string OR an array of (string | {type,text}) parts. */
function flattenText(text: unknown): string {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  return "";
}

/** Media/service messages are skipped in v1 — we only compile plain text. */
function hasMedia(m: any): boolean {
  return Boolean(m.photo || m.file || m.media_type || m.poll || m.location_information || m.contact_information);
}

function toIso(m: any): string | null {
  if (m.date_unixtime) {
    const t = Number(m.date_unixtime);
    if (Number.isFinite(t) && t > 0) return new Date(t * 1000).toISOString();
  }
  if (m.date) {
    const d = new Date(m.date);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;

  const { space_id, file_uri } = await req.json().catch(() => ({}));
  if (!space_id || !file_uri) {
    return Response.json({ error: "space_id and file_uri required" }, { status: 400 });
  }

  // --- auth: authenticated member of this space only -----------------------
  const user = await base44.auth.me().catch(() => null);
  if (!user?.email) return Response.json({ error: "unauthorized" }, { status: 401 });

  const space = await sr.entities.Space.get(space_id).catch(() => null);
  if (!space) return Response.json({ error: "space not found" }, { status: 404 });

  const memberEmails: string[] = space.member_emails ?? [];
  let isMember = memberEmails.includes(user.email);
  if (!isMember) {
    const m = await sr.entities.Membership.filter({ space_id, user_email: user.email }, undefined, 1);
    isMember = m.length > 0;
  }
  if (!isMember) return Response.json({ error: "not a member of this space" }, { status: 403 });

  // --- job row (dashboard subscribes to this for live progress) ------------
  const job = await sr.entities.ImportJob.create({
    space_id,
    status: "running",
    total: 0,
    done: 0,
    member_emails: memberEmails,
  });

  try {
    // --- fetch the export JSON via a signed URL ----------------------------
    const { signed_url } = await sr.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 600 });
    const exportJson: any = await fetch(signed_url).then((r) => r.json());
    const messages: any[] = Array.isArray(exportJson?.messages) ? exportJson.messages : [];

    // --- parse: keep only plain-text `type:"message"` rows -----------------
    let skippedNonMessage = 0, skippedMedia = 0, skippedEmpty = 0;
    const eligible: any[] = [];
    for (const m of messages) {
      if (m?.type !== "message") { skippedNonMessage++; continue; }
      if (hasMedia(m)) { skippedMedia++; continue; }
      const text = flattenText(m.text).trim();
      const sent_at = toIso(m);
      if (!text || !sent_at) { skippedEmpty++; continue; }
      eligible.push({ id: m.id, from: m.from, text, sent_at });
    }

    const cappedOff = Math.max(0, eligible.length - MESSAGE_CAP);
    const capped = eligible.slice(0, MESSAGE_CAP);
    const skipped = skippedNonMessage + skippedMedia + skippedEmpty + cappedOff;
    console.log(
      `import-history space=${space_id} messages=${messages.length} eligible=${eligible.length} ` +
      `importing=${capped.length} skipped=${skipped} ` +
      `(non-message=${skippedNonMessage} media=${skippedMedia} empty=${skippedEmpty} over-cap=${cappedOff})`,
    );

    // --- dedup against anything already imported (idempotent re-import) -----
    const existing = await sr.entities.RawMessage.filter({ space_id }, "-sent_at", MESSAGE_CAP + 500, 0, ["tg_update_id"]);
    const seen = new Set(existing.map((r: any) => r.tg_update_id));

    const rows = capped
      .map((m) => ({
        space_id,
        tg_update_id: `import-${space_id}-${m.id}`,
        tg_message_id: String(m.id),
        sender_name: m.from || "Unknown",
        text: m.text,
        media_type: "none",
        sent_at: m.sent_at,
        processed: false,
        member_emails: memberEmails,
      }))
      .filter((r) => !seen.has(r.tg_update_id));

    if (rows.length > 0) await sr.entities.RawMessage.bulkCreate(rows);

    const total = rows.length;
    await sr.entities.ImportJob.update(job.id, { total });

    if (total === 0) {
      await sr.entities.ImportJob.update(job.id, { status: "done", done: 0 });
      return Response.json({ ok: true, job_id: job.id, total: 0, skipped, note: "nothing new to import" });
    }

    // --- compile in batches through the real pipeline ----------------------
    // process-messages compiles up to ~50 unprocessed rows per invocation.
    const MAX_BATCHES = Math.ceil(total / 40) + 10; // ponytail: hard loop guard; 50/batch means this is generous
    let done = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const res: any = await sr.functions.invoke("process-messages", { space_id, force: true });
      const body = res?.data ?? res ?? {};
      if (body.skipped === "empty") break;
      const compiled = body.compiled ?? 0;
      if (!compiled) break; // nothing advanced → stop rather than spin
      done = Math.min(total, done + compiled);
      await sr.entities.ImportJob.update(job.id, { done });
    }

    await sr.entities.ImportJob.update(job.id, { status: "done", done: total });
    return Response.json({ ok: true, job_id: job.id, total, imported: total, skipped });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sr.entities.ImportJob.update(job.id, { status: "error", error_text: message }).catch(() => {});
    return Response.json({ error: message, job_id: job.id }, { status: 500 });
  }
});
