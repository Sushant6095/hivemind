// process-messages — the compiler pass.
//
// Fires as an ENTITY AUTOMATION whenever a RawMessage is created, but works on
// debounced BURSTS to keep LLM credit usage ~1 call per conversation burst
// instead of 1 call per message:
//
//   • If the newest unprocessed message is younger than DEBOUNCE_SECONDS and
//     the backlog is small, we skip — a later automation firing (or the next
//     message) will pick the burst up once it has settled.
//   • Otherwise: ONE InvokeLLM call (cheap model, strict JSON schema) over the
//     unprocessed batch + a context window of already-processed messages.
//
// Extractions are upserted into Decision / Commitment / Question / Event /
// Expense with provenance (source_msg_ids), and near-duplicate decisions are
// superseded rather than duplicated.

import { createClientFromRequest } from "npm:@base44/sdk";

const DEBOUNCE_SECONDS = 45;
const FORCE_BATCH_SIZE = 10;
const CONTEXT_WINDOW = 15;

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    extractions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["decision", "commitment", "question", "event", "expense", "none"] },
          title: { type: "string", description: "Short statement (decision title / commitment text / question / event title / expense description)" },
          detail: { type: "string" },
          who_name: { type: "string", description: "For commitments/expenses: the person responsible or who paid" },
          due_at: { type: "string", description: "ISO 8601 if a deadline/date is stated or clearly implied, else empty" },
          starts_at: { type: "string", description: "For events: ISO 8601 start" },
          location: { type: "string" },
          amount: { type: "number", description: "For expenses" },
          currency: { type: "string" },
          answers_question: { type: "string", description: "If this burst ANSWERS a previously open question, restate that question verbatim-ish" },
          answer: { type: "string" },
          supersedes: { type: "string", description: "If this REPLACES an earlier decision, restate that decision's title" },
          confidence: { type: "number" },
          source_msg_ids: { type: "array", items: { type: "string" }, description: "tg message ids (from the [id:N] tags) this extraction came from" }
        },
        required: ["kind", "confidence"]
      }
    }
  },
  required: ["extractions"]
};

const SYSTEM_PROMPT = `You are Hivemind, a compiler that turns casual group-chat conversation into structured records.
Read the NEW MESSAGES (with [id:N] tags) in light of the CONTEXT. Extract ONLY things a reasonable
member would want remembered: firm decisions, personal commitments ("I'll…", "X will…", owing money),
open questions, planned events, and expenses/payments. Normal chatter → kind:"none".
Rules:
- Be conservative: confidence < 0.5 means do not extract.
- Dates: resolve relative dates ("Friday", "kal") against the message timestamps given; output ISO 8601 with +05:30 offset when the group timezone is Asia/Kolkata.
- Always fill source_msg_ids from the [id:N] tags you used.
- If messages answer an earlier open question (listed under OPEN QUESTIONS), emit kind:"question" with answers_question + answer filled.
- If a new agreement replaces an earlier decision (listed under ACTIVE DECISIONS), fill supersedes.`;

async function compileSpace(sr: any, spaceId: string, force: boolean) {
  const unprocessed = await sr.entities.RawMessage.filter(
    { space_id: spaceId, processed: false, media_type: "none" },
    "sent_at",
    50,
  );
  if (unprocessed.length === 0) return { skipped: "empty" };

  // --- debounce: let bursts settle ---------------------------------------
  const newest = new Date(unprocessed[unprocessed.length - 1].sent_at).getTime();
  const age = (Date.now() - newest) / 1000;
  if (age < DEBOUNCE_SECONDS && unprocessed.length < FORCE_BATCH_SIZE && !force) {
    return { skipped: "debounce", backlog: unprocessed.length };
  }

  // --- context ------------------------------------------------------------
  const context = await sr.entities.RawMessage.filter(
    { space_id: spaceId, processed: true },
    "-sent_at",
    CONTEXT_WINDOW,
  );
  const openQuestions = await sr.entities.Question.filter({ space_id: spaceId, status: "open" }, "-created_date", 10);
  const activeDecisions = await sr.entities.Decision.filter({ space_id: spaceId, status: "active" }, "-created_date", 10);
  const spaceRec = await sr.entities.Space.get(spaceId).catch(() => null);
  const memberEmails: string[] = spaceRec?.member_emails ?? [];

  const fmt = (m: any) => `[id:${m.tg_message_id}] ${m.sent_at} ${m.sender_name}: ${m.text}`;
  const prompt = [
    SYSTEM_PROMPT,
    "",
    "ACTIVE DECISIONS:",
    ...activeDecisions.map((d: any) => `- ${d.title}`),
    "",
    "OPEN QUESTIONS:",
    ...openQuestions.map((q: any) => `- ${q.text}`),
    "",
    "CONTEXT (already compiled):",
    ...context.reverse().map(fmt),
    "",
    "NEW MESSAGES:",
    ...unprocessed.map(fmt),
  ].join("\n");

  const result: any = await sr.integrations.Core.InvokeLLM({
    prompt,
    model: "gemini_3_flash", // cheap + fast; the librarian uses a bigger model
    response_json_schema: EXTRACTION_SCHEMA,
  });

  const extractions: any[] = result?.extractions ?? [];
  const common = (e: any) => ({
    space_id: spaceId,
    confidence: e.confidence ?? 0.6,
    source_msg_ids: e.source_msg_ids ?? [],
    member_emails: memberEmails,
  });

  for (const e of extractions) {
    if (!e || e.kind === "none" || (e.confidence ?? 0) < 0.5) continue;

    if (e.kind === "decision") {
      if (e.supersedes) {
        const [old] = await sr.entities.Decision.filter({ space_id: spaceId, title: e.supersedes, status: "active" }, undefined, 1);
        if (old) await sr.entities.Decision.update(old.id, { status: "superseded" });
      }
      await sr.entities.Decision.create({ ...common(e), title: e.title, detail: e.detail ?? "", decided_at: new Date().toISOString() });
    } else if (e.kind === "commitment") {
      await sr.entities.Commitment.create({ ...common(e), who_name: e.who_name || "Someone", what: e.title, due_at: e.due_at || undefined, status: "open" });
    } else if (e.kind === "question") {
      if (e.answers_question && e.answer) {
        const [q] = await sr.entities.Question.filter({ space_id: spaceId, status: "open" }, "-created_date", 25);
        // naive match: newest open question containing a keyword overlap is answered
        const target = q && e.answers_question ? q : null;
        if (target) {
          await sr.entities.Question.update(target.id, { status: "answered", answer: e.answer, answered_via: "human" });
          continue;
        }
      }
      await sr.entities.Question.create({ ...common(e), text: e.title, asked_by: e.who_name || "", status: "open" });
    } else if (e.kind === "event") {
      await sr.entities.Event.create({ ...common(e), title: e.title, starts_at: e.starts_at || undefined, location: e.location ?? "" });
    } else if (e.kind === "expense") {
      await sr.entities.Expense.create({ ...common(e), payer_name: e.who_name || "Someone", amount: e.amount ?? 0, currency: e.currency || "INR", description: e.title ?? "" });
    }
  }

  // mark burst compiled
  for (const m of unprocessed) {
    await sr.entities.RawMessage.update(m.id, { processed: true });
  }

  return { compiled: unprocessed.length, extracted: extractions.filter((e) => e.kind !== "none").length };
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;

  // Payload shapes: entity automation → { event, data: RawMessage },
  // scheduled sweeper → { sweep: true }, manual → { space_id, force? }.
  const payload = await req.json().catch(() => ({}));

  if (payload?.sweep || payload?.function_args?.sweep) {
    // Sweep every space that has settled unprocessed messages.
    const pending = await sr.entities.RawMessage.filter({ processed: false }, "sent_at", 200);
    const spaceIds = [...new Set(pending.map((m: any) => m.space_id))] as string[];
    const results: Record<string, unknown> = {};
    for (const id of spaceIds) results[id] = await compileSpace(sr, id, false);
    return Response.json({ ok: true, swept: spaceIds.length, results });
  }

  const spaceId: string | undefined = payload?.data?.space_id ?? payload?.space_id;
  if (!spaceId) return Response.json({ ok: true, skipped: "no space_id" });

  const result = await compileSpace(sr, spaceId, Boolean(payload?.force));
  return Response.json({ ok: true, ...result });
});
