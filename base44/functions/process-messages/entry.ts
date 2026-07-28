// process-messages — the compiler pass.
//
// Invoked fire-and-forget by telegram-webhook on every inbound message, and on
// a schedule as a WORKFLOW with {"sweep": true} as a safety net. (Legacy
// `automations` blocks are rejected by this app's Workflows runtime with a 409,
// so the schedule has to live as a Workflow.)
//
// It works on debounced BURSTS to keep LLM usage at ~1 call per conversation
// burst instead of 1 call per message:
//
//   • A burst of FORCE_BATCH_SIZE or more compiles immediately.
//   • A smaller burst is WAITED OUT in-process for the remainder of
//     DEBOUNCE_SECONDS and then re-read — we do NOT return and hope a sweeper
//     comes back for us. Returning was the old behaviour and it had a nasty
//     failure mode: someone types two messages, every invocation answers
//     {skipped:"debounce"}, and the product looks dead until the next sweep.
//     Racing waiters are safe — the lease admits exactly one compiler per
//     space and the losers re-read an empty backlog and no-op.
//   • Then: ONE InvokeLLM call (cheap model, strict JSON schema) over the
//     unprocessed batch + a context window of already-processed messages.
//
// Extractions are upserted into Decision / Commitment / Question / Event /
// Expense with provenance (source_msg_ids), and near-duplicate decisions are
// superseded rather than duplicated. Every pass is recorded as a CompileJob so
// a crash is recoverable (see compile-reaper) and as a MetricEvent so the
// Engine Room can show real latency and extraction counts.

import { createClientFromRequest } from "npm:@base44/sdk";

const DEBOUNCE_SECONDS = 15;
const FORCE_BATCH_SIZE = 3;
const MAX_SETTLE_MS = 20_000; // hard ceiling on the in-process settle wait
const CONTEXT_WINDOW = 15;

// ── distributed lease ───────────────────────────────────────────────────
// telegram-webhook invokes this function once per message, so a 12-line burst
// spawns 12 concurrent passes. Without mutual exclusion, the pass that starts
// at message #10 is still inside its 2-5s LLM call when #11 and #12 read the
// same still-unprocessed rows and start their own passes — producing duplicate
// decision/commitment/expense cards and tripling LLM spend on every burst.
//
// Base44 entities carry no unique index, so "filter then create" is a
// check-then-act race. We use the sequential-node pattern (ZooKeeper-style):
// every contender creates its own row, then re-reads all live rows for the key
// in creation order. The oldest row wins; every other contender deletes its own
// row and backs off. Leases carry a TTL, so a holder that crashes mid-LLM-call
// cannot deadlock the space — the lease simply expires.
//
// Caveat: if two rows land in the same millisecond the creation order may be
// arbitrary, but it is consistent across all readers, which is all that mutual
// exclusion requires.
const LEASE_TTL_MS = 150_000; // > worst-case LLM round trip
const DAILY_LLM_CAP = 200; // per space, per UTC day
const RETRY_BASE_MS = 30_000; // 30s → 60s → 120s → 240s → dead-letter
const MAX_ATTEMPTS = 5;

async function acquireLease(sr: any, key: string) {
  const now = Date.now();
  const live = (rows: any[]) => rows.filter((l) => new Date(l.expires_at).getTime() > now);

  const before = await sr.entities.Lease.filter({ key }, "created_date", 20);
  if (live(before).length > 0) return null; // held by someone else

  for (const stale of before) {
    // GC expired holders
    await sr.entities.Lease.delete(stale.id).catch(() => {});
  }

  const mine = await sr.entities.Lease.create({
    key,
    token: crypto.randomUUID(),
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + LEASE_TTL_MS).toISOString(),
  });

  // resolve the race: re-read; oldest live row is the winner
  const after = live(await sr.entities.Lease.filter({ key }, "created_date", 20));
  if (after.length > 1 && after[0].id !== mine.id) {
    await sr.entities.Lease.delete(mine.id).catch(() => {});
    return null;
  }
  return mine;
}

async function releaseLease(sr: any, lease: any) {
  if (lease?.id) await sr.entities.Lease.delete(lease.id).catch(() => {});
}

// ── BM25 lexical retrieval ──────────────────────────────────────────────
// Okapi BM25, implemented in place: no embedding round-trip, no vector store,
// deterministic and sub-millisecond at group scale. Here it decides which OPEN
// QUESTION a burst actually answered, instead of "whichever is newest".
const STOP = new Set(
  "a an the is are was were be been to of in on for and or we i you it that this at by with about our us".split(" "),
);
const tok = (s: string) =>
  ((s ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

function bm25(query: string, docs: { id: string; text: string; meta?: any }[], k = 8) {
  const q = [...new Set(tok(query))];
  if (!q.length || !docs.length) return [];
  const D = docs.map((d) => ({ ...d, terms: tok(d.text) }));
  const avgdl = D.reduce((s, d) => s + d.terms.length, 0) / D.length || 1;
  const df: Record<string, number> = {};
  for (const d of D) for (const t of new Set(d.terms)) df[t] = (df[t] ?? 0) + 1;
  const K1 = 1.5, B = 0.75;
  return D.map((d) => {
    const tf: Record<string, number> = {};
    for (const t of d.terms) tf[t] = (tf[t] ?? 0) + 1;
    let score = 0;
    for (const t of q) {
      if (!tf[t]) continue;
      const idf = Math.log(1 + (D.length - (df[t] ?? 0) + 0.5) / ((df[t] ?? 0) + 0.5));
      score += idf * (tf[t] * (K1 + 1)) / (tf[t] + K1 * (1 - B + B * (d.terms.length / avgdl)));
    }
    return { id: d.id, text: d.text, meta: d.meta, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cheap read-only probe. Used to avoid parking a sleeper behind a compile that
// is already in flight — without it, a long LLM call would collect one waiting
// invocation per inbound message.
async function leaseHeld(sr: any, key: string) {
  const now = Date.now();
  const rows = await sr.entities.Lease.filter({ key }, "created_date", 20).catch(() => []);
  return rows.some((l: any) => new Date(l.expires_at).getTime() > now);
}

// How much longer this burst needs before it is worth an LLM call.
// 0 means "compile now". Clamped, because sent_at comes from the sender's
// clock via Telegram and cannot be trusted to be sane.
function settleMs(rows: any[]) {
  if (rows.length >= FORCE_BATCH_SIZE) return 0;
  const newest = new Date(rows[rows.length - 1].sent_at).getTime();
  if (!Number.isFinite(newest)) return 0;
  const ageS = (Date.now() - newest) / 1000;
  if (ageS >= DEBOUNCE_SECONDS) return 0;
  return Math.min(Math.round((DEBOUNCE_SECONDS - ageS) * 1000), MAX_SETTLE_MS);
}

async function readBacklog(sr: any, spaceId: string) {
  return await sr.entities.RawMessage.filter(
    { space_id: spaceId, processed: false, media_type: "none" },
    "sent_at",
    50,
  );
}

async function compileSpace(sr: any, spaceId: string, force: boolean) {
  let unprocessed = await readBacklog(sr, spaceId);
  if (unprocessed.length === 0) return { skipped: "empty" };

  // --- debounce: wait the burst out, don't bail on it ---------------------
  if (!force) {
    const waitMs = settleMs(unprocessed);
    if (waitMs > 0) {
      if (await leaseHeld(sr, `compile:${spaceId}`)) return { skipped: "locked" };
      await sleep(waitMs);
      unprocessed = await readBacklog(sr, spaceId);
      if (unprocessed.length === 0) return { skipped: "empty" }; // another pass took it
    }
  }

  // --- mutual exclusion ---------------------------------------------------
  // The debounce check above is deliberately OUTSIDE the lease: it is cheap and
  // uncontended. Everything from here on mutates shared state.
  const lease = await acquireLease(sr, `compile:${spaceId}`);
  if (!lease) return { skipped: "locked" }; // another pass owns this burst
  try {
    return await compileLocked(sr, spaceId, unprocessed);
  } finally {
    await releaseLease(sr, lease);
  }
}

// The critical section: only ever entered by one pass per space at a time.
async function compileLocked(sr: any, spaceId: string, unprocessed: any[]) {
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

  // --- per-space daily spend cap ------------------------------------------
  // Reuses Space.stats — no new entity. A runaway loop or an abusive group
  // cannot silently burn the whole LLM budget.
  const today = new Date().toISOString().slice(0, 10);
  const stats = spaceRec?.stats ?? {};
  const calls = stats.llm_day === today ? (stats.llm_calls ?? 0) : 0;
  if (calls >= DAILY_LLM_CAP) return { skipped: "daily_cap", calls };
  await sr.entities.Space.update(spaceId, {
    stats: { ...stats, llm_day: today, llm_calls: calls + 1 },
  });

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

  // --- durable job record --------------------------------------------------
  // Before this existed, a thrown InvokeLLM left the batch processed:false
  // forever with no record that anything failed and no bounded retry. Every
  // batch now ends in `done` or `dead` — never silently dropped.
  const t0 = Date.now();
  const job = await sr.entities.CompileJob.create({
    space_id: spaceId,
    state: "running",
    attempts: 1,
    max_attempts: MAX_ATTEMPTS,
    batch_size: unprocessed.length,
    started_at: new Date(t0).toISOString(),
    member_emails: memberEmails,
  }).catch(() => null);

  try {
    return await runExtraction(sr, spaceId, unprocessed, prompt, memberEmails, job, t0);
  } catch (err) {
    // Exponential backoff: 30s, 60s, 120s, 240s, then dead-letter. Messages
    // stay processed:false — the reaper owns the retry, not this invocation.
    const attempts = job?.attempts ?? 1;
    const delay = RETRY_BASE_MS * Math.pow(2, attempts - 1);
    if (job?.id) {
      await sr.entities.CompileJob.update(job.id, {
        state: attempts >= MAX_ATTEMPTS ? "dead" : "retrying",
        attempts,
        last_error: String(err).slice(0, 500),
        next_attempt_at: new Date(Date.now() + delay).toISOString(),
        duration_ms: Date.now() - t0,
        finished_at: new Date().toISOString(),
      }).catch(() => {});
    }
    await sr.entities.MetricEvent.create({
      space_id: spaceId,
      kind: "compile",
      ok: false,
      duration_ms: Date.now() - t0,
      model: "gemini_3_flash",
      input_chars: prompt.length,
      meta: { batch: unprocessed.length, error: String(err).slice(0, 200) },
      member_emails: memberEmails,
    }).catch(() => {});
    return { failed: true, job: job?.id ?? null };
  }
}

// The extraction itself. Split out so the job/metric bookkeeping above reads as
// one unit and every throw lands in exactly one catch.
async function runExtraction(
  sr: any,
  spaceId: string,
  unprocessed: any[],
  prompt: string,
  memberEmails: string[],
  job: any,
  t0: number,
) {
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
        const open = await sr.entities.Question.filter({ space_id: spaceId, status: "open" }, "-created_date", 25);
        // Score the model's restatement against EVERY open question and take the
        // best match above a floor — never "whichever question happens to be
        // newest", which flipped an unrelated card and left the real one open.
        const [hit] = bm25(e.answers_question, open.map((q: any) => ({ id: q.id, text: q.text })), 1);
        if (hit && hit.score >= 0.8) {
          await sr.entities.Question.update(hit.id, { status: "answered", answer: e.answer, answered_via: "human" });
          continue;
        }
        // no confident match → fall through and record it as a new question
      }
      await sr.entities.Question.create({ ...common(e), text: e.title, asked_by: e.who_name || "", status: "open" });
    } else if (e.kind === "event") {
      await sr.entities.Event.create({ ...common(e), title: e.title, starts_at: e.starts_at || undefined, location: e.location ?? "" });
    } else if (e.kind === "expense") {
      await sr.entities.Expense.create({ ...common(e), payer_name: e.who_name || "Someone", amount: e.amount ?? 0, currency: e.currency || "INR", description: e.title ?? "" });
    }
  }

  // mark burst compiled — batched: 50 sequential round trips was the slowest
  // part of the critical section, and it holds the lease the whole time.
  for (let i = 0; i < unprocessed.length; i += 10) {
    await Promise.all(
      unprocessed.slice(i, i + 10).map((m: any) => sr.entities.RawMessage.update(m.id, { processed: true })),
    );
  }

  const written = extractions.filter((e) => e && e.kind !== "none" && (e.confidence ?? 0) >= 0.5).length;

  if (job?.id) {
    await sr.entities.CompileJob.update(job.id, {
      state: "done",
      extracted: written,
      duration_ms: Date.now() - t0,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
  }

  // Fire-and-forget metric — observability must never break the pipeline.
  await sr.entities.MetricEvent.create({
    space_id: spaceId,
    kind: "compile",
    ok: true,
    duration_ms: Date.now() - t0,
    model: "gemini_3_flash",
    input_chars: prompt.length,
    meta: { batch: unprocessed.length, extracted: written },
    member_emails: memberEmails,
  }).catch(() => {});

  return { compiled: unprocessed.length, extracted: written };
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
    for (const id of spaceIds) {
      const r = await compileSpace(sr, id, false);
      results[id] = r;
      // analytics: best-effort, must never break the compiler pipeline
      try {
        (base44 as any).analytics?.track({
          eventName: "compile_burst",
          properties: { extracted: (r as any).extracted ?? 0, skipped: (r as any).skipped ?? "" },
        });
      } catch (_) { /* fire-and-forget */ }
    }
    return Response.json({ ok: true, swept: spaceIds.length, results });
  }

  const spaceId: string | undefined = payload?.data?.space_id ?? payload?.space_id;
  if (!spaceId) return Response.json({ ok: true, skipped: "no space_id" });

  const result = await compileSpace(sr, spaceId, Boolean(payload?.force));
  // analytics: best-effort, must never break the compiler pipeline
  try {
    (base44 as any).analytics?.track({
      eventName: "compile_burst",
      properties: { extracted: (result as any).extracted ?? 0, skipped: (result as any).skipped ?? "" },
    });
  } catch (_) { /* fire-and-forget */ }
  return Response.json({ ok: true, ...result });
});
