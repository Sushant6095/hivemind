// demo — the no-login judge path.
//
// Every other space-scoped function in this app is gated (see ask/mark-done/
// research). This one is deliberately, narrowly public: it returns a READ-ONLY
// snapshot of exactly one space — the seeded "Goa Trip (Demo)" — so a first-time
// visitor sees a real compiled board before deciding whether to sign in.
//
// Three things keep "public" from meaning "open":
//   • it resolves ONE space and ignores any space_id the caller sends, so it
//     cannot be pointed at somebody's real group;
//   • it is read-only — no entity is created, updated or deleted;
//   • every field it returns is named in the PICK allow-list below, so the
//     member_emails, invite_code, who_tg_id and file-storage handles carried by
//     these entities cannot reach an anonymous caller — including after a future
//     schema change, which is the failure a blocklist would not have survived.
//
// The whole board arrives in one round trip because the demo has no session to
// subscribe with: realtime needs an authenticated socket, so the demo renders a
// snapshot and says so, rather than faking a live badge it hasn't earned.

import { createClientFromRequest } from "npm:@base44/sdk";

const KINDS = ["Decision", "Commitment", "Question", "Event", "Expense"] as const;
const ROW_CAP = 60;
const MSG_CAP = 400;

// seed-demo stamps demo spaces with tg_chat_id = "demo-<uuid8>". That prefix is
// the fallback discriminator when DEMO_SPACE_ID isn't pinned, so a stray real
// group can never be selected by accident.
const DEMO_CHAT_PREFIX = "demo-";

// Every response is built by copying named fields OUT of a row, never by
// deleting fields from it. A blocklist is one schema change away from leaking:
// add a column to an entity and a blocklist ships it to the public internet on
// the next deploy, silently. This is the same discipline as RESOURCES.pick in
// the `api` function, and it is why `member_emails` — present on every one of
// these entities — cannot appear here even by accident.
const COMMON = ["id", "space_id", "source_msg_ids", "confidence", "created_date"] as const;

const PICK: Record<string, readonly string[]> = {
  Decision: [...COMMON, "title", "detail", "status", "decided_at"],
  // who_tg_id is deliberately absent: who_name is what the board renders, and a
  // Telegram user id is a durable handle to a real person.
  Commitment: [...COMMON, "who_name", "what", "due_at", "status"],
  Question: [...COMMON, "text", "answer", "status", "answered_via"],
  Event: [...COMMON, "title", "starts_at", "location"],
  // receipt_file_uri is absent for the same reason: the receipt button is
  // src.demo-gated in the UI, so the demo has no use for a storage handle.
  Expense: [...COMMON, "payer_name", "amount", "currency", "description", "items"],
  RawMessage: [
    "id",
    "space_id",
    "tg_message_id",
    "sender_name",
    "text",
    "media_type",
    "sent_at",
  ],
  Space: [
    "id",
    "name",
    "tg_chat_id",
    "tg_chat_title",
    "timezone",
    "stats",
    "cover_image_url",
  ],
};

/** Copy only the allow-listed fields of `row`. Absent fields stay absent. */
function pick(kind: string, row: any) {
  const out: Record<string, unknown> = {};
  for (const f of PICK[kind]) if (row?.[f] !== undefined) out[f] = row[f];
  return out;
}

async function resolveSpace(sr: any) {
  const pinned = Deno.env.get("DEMO_SPACE_ID");
  if (pinned) {
    const s = await sr.entities.Space.get(pinned).catch(() => null);
    if (s) return s;
  }
  const rows = await sr.entities.Space.list("-created_date", 50).catch(() => []);
  return rows.find((s: any) => String(s.tg_chat_id ?? "").startsWith(DEMO_CHAT_PREFIX)) ?? null;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;

  const space = await resolveSpace(sr);
  if (!space) {
    // Honest empty state: the dashboard falls back to its own copy rather than
    // rendering an empty board that reads as a broken product.
    return Response.json({ ok: false, reason: "no demo space seeded" }, { status: 404 });
  }

  const [rows, messages] = await Promise.all([
    Promise.all(
      KINDS.map((k) => sr.entities[k].filter({ space_id: space.id }, "-created_date", ROW_CAP).catch(() => [])),
    ),
    sr.entities.RawMessage.filter({ space_id: space.id }, "-sent_at", MSG_CAP).catch(() => []),
  ]);

  const payload: Record<string, unknown> = { ok: true, space: pick("Space", space) };
  KINDS.forEach((k, i) => (payload[k] = rows[i].map((r: any) => pick(k, r))));
  payload.RawMessage = messages.map((m: any) => pick("RawMessage", m));
  payload.counts = {
    compiled: rows.reduce((n, r) => n + r.length, 0),
    messages: messages.length,
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      // The demo space only changes when someone re-seeds it. Let the edge and
      // the browser absorb a judging-day traffic spike instead of the database.
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    },
  });
});
