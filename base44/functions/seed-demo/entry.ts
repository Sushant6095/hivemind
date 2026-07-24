// seed-demo — one-shot judge experience.
//
// Creates a "Goa Trip (Demo)" space and REPLAYS a realistic 2-week group
// conversation through the real pipeline: RawMessages are inserted unprocessed
// and process-messages is invoked with force, so judges watch the board fill
// through the exact same code path a live group uses. Protected by a shared
// key so strangers can't spam the demo.
//
//   curl -X POST <fn-url>/seed-demo -H 'Content-Type: application/json' \
//        -d '{"key":"<SEED_DEMO_KEY>","email":"judge@base44.com"}'

import { createClientFromRequest } from "npm:@base44/sdk";

const SCRIPT: Array<[string, string, number]> = [
  // [sender, text, minutes-ago-offset from ~14 days]
  ["Priya", "ok so are we finally doing the Goa trip or what 😂", 20160],
  ["Raj", "YES. I'm in. August 14-17 long weekend?", 20155],
  ["Ananya", "works for me!", 20150],
  ["Sushant", "same. let's lock it — Goa, Aug 14 to 17", 20145],
  ["Priya", "decided ✅ I'll book the villa this week, saw one in Anjuna for 12k/night", 20140],
  ["Raj", "budget check — are we saying 40k total per person all-in?", 20130],
  ["Sushant", "40k cap sounds right, flights are ~9k return rn", 20125],
  ["Ananya", "ok so who's booking flights? I did it last time 😤", 20120],
  ["Priya", "I'll do flights too, by Friday promise", 20115],
  ["Raj", "anyone know if August is too rainy for Anjuna?", 20110],
  ["Sushant", "no idea honestly", 20105],
  ["Raj", "paid the villa deposit btw — 15,000, split it later", 10080],
  ["Ananya", "🐐", 10075],
  ["Priya", "flights NOT booked yet, prices jumped, waiting for tue sale", 10070],
  ["Sushant", "ok but don't let it slip past this week pls", 10065],
  ["Ananya", "scuba on day 2? I'll organize if everyone's in", 4320],
  ["Raj", "innn", 4315],
  ["Priya", "in! also dinner at Thalassa on the 15th, I'll reserve for 8pm", 4310],
  ["Sushant", "book it 🙌", 4305],
];

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const { key, email } = await req.json().catch(() => ({}));

  const expected = Deno.env.get("SEED_DEMO_KEY");
  if (!expected || key !== expected) return Response.json({ error: "forbidden" }, { status: 403 });

  const memberEmails = email ? [email] : [];
  const space = await sr.entities.Space.create({
    name: "Goa Trip (Demo)",
    tg_chat_id: `demo-${crypto.randomUUID().slice(0, 8)}`,
    tg_chat_title: "Goa Trip (Demo)",
    invite_code: crypto.randomUUID().split("-")[0],
    member_emails: memberEmails,
    timezone: "Asia/Kolkata",
    stats: { messages_seen: SCRIPT.length, demo: true },
  });

  if (email) {
    await sr.entities.Membership.create({ space_id: space.id, user_email: email, tg_display_name: email, role: "owner", member_emails: memberEmails });
  }

  const now = Date.now();
  let i = 0;
  for (const [sender, text, minAgo] of SCRIPT) {
    await sr.entities.RawMessage.create({
      space_id: space.id,
      tg_update_id: `demo-${space.id}-${i}`,
      tg_message_id: String(1000 + i),
      sender_name: sender,
      text,
      media_type: "none",
      sent_at: new Date(now - minAgo * 60_000).toISOString(),
      processed: false,
      member_emails: memberEmails,
    });
    i++;
  }

  // Run the real compiler over the replay (force past the debounce).
  await base44.functions.invoke("process-messages", { space_id: space.id, force: true });

  return Response.json({
    ok: true,
    space_id: space.id,
    invite_code: space.invite_code,
    note: "Open the dashboard with this account — the demo space is compiled and live.",
  });
});
